/**
 * Agent-state poller.
 *
 * Keeps a live snapshot of the credit engine's on-chain + log state so
 * the bridge surface can ground the wizard (and the future tower-chest
 * renderer, the second-floor sign, etc.) in real numbers instead of
 * hallucinated ones.
 *
 * The poller is read-only:
 *   - `LpVault.totalAssets()`         — vault USDC; the chests' visible weight.
 *   - `LpVault.totalSupply()`         — vLP shares outstanding.
 *   - `LoanBook.outstandingPrincipal` — sum of active-loan principals.
 *   - `log.walkFromTip()[0]`          — id/type/ts of the most-recent appended event.
 *   - `LoanRegistry.size()` (caller-supplied) — active-loan count.
 *
 * Refresh cadence: 15 s. A failed read marks the snapshot `stale: true`
 * but never blanks it — the wizard quotes the last-known numbers rather
 * than make new ones up. `snapshot()` returns synchronously from cache;
 * only `refreshNow()` and the background timer hit the chain.
 */

import type { Address, PublicClient } from "viem";

import type { Sha256Hex } from "@vanta/tee";

import type { FileEventLog } from "../events-store.js";

const LP_VAULT_STATE_ABI = [
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

const LOAN_BOOK_STATE_ABI = [
  {
    type: "function",
    name: "outstandingPrincipal",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

export interface AgentStateSnapshot {
  /** USDC 6-dec wei held by the LpVault, as a decimal-digit string. */
  readonly lpVaultTotalAssetsUsdc6: string;
  /** vLP shares outstanding, also a decimal-digit string. */
  readonly lpVaultTotalSupplyShares: string;
  /** Sum of `principal` for all loans currently in `Active` status. */
  readonly outstandingPrincipalUsdc6: string;
  /** From the in-memory LoanRegistry. */
  readonly activeLoanCount: number;
  /** Most-recent appended event metadata; null when the log is empty. */
  readonly lastEventId: Sha256Hex | null;
  readonly lastEventType: string | null;
  readonly lastEventTimestamp: number | null;
  /**
   * 1 ingot per 100 USDC, capped at the 9-chest grid the tower carries
   * (9 chests × 27 slots × 64 stack = 15_552). The bridge-plugin chest
   * renderer reads this directly and never re-derives it on the Kotlin
   * side, so the conversion stays single-sourced here.
   */
  readonly chestIngotsApprox: number;
  /**
   * Live `owner()` reads off the deployed contracts. Surfaced to the
   * /api/identity-pin route so the launcher's owner banner can show
   * three identical addresses (TEE EOA ≡ LpVault.owner ≡ LoanBook.owner)
   * — the credibility primitive that no other agent demo can fake.
   */
  readonly lpVaultOwner: string | null;
  readonly loanBookOwner: string | null;
  /** When this snapshot was fetched (ms since epoch). 0 = never. */
  readonly fetchedAt: number;
  /** True iff the most-recent fetch attempt failed; cached values are previous. */
  readonly stale: boolean;
}

export interface AgentState {
  /** Synchronous read of the most-recent snapshot. Always returns a value. */
  readonly snapshot: () => AgentStateSnapshot;
  /** Begin background polling. Idempotent. */
  readonly start: () => void;
  /** Stop background polling. */
  readonly stop: () => void;
  /** Force a refresh; resolves with the new snapshot. */
  readonly refreshNow: () => Promise<AgentStateSnapshot>;
  /**
   * Demo-mode deposit accumulator. The bots' Cynthia/Daniel cycles
   * narrate USDC deposits in chat; until those are wired to a real
   * LpVault.deposit() call, this lets the chest renderer track them
   * as a "demo balance" so the visible vault still grows. The total
   * is added to the on-chain `totalAssets()` when computing
   * `chest_ingots_approx`. Negative deltas are allowed for redemptions.
   */
  readonly addDemoDepositUsdc6: (raw6: bigint) => void;
}

export interface CreateAgentStateOpts {
  readonly publicClient: PublicClient;
  readonly lpVaultAddress: Address;
  readonly loanBookAddress: Address;
  readonly log: FileEventLog;
  /** Typically `() => loanRegistry.size()`. */
  readonly activeLoanCount: () => number;
  /** Background refresh cadence in ms. Default 15_000. */
  readonly refreshIntervalMs?: number;
  /**
   * If true, skip on-chain reads. Used by the SKIP_CONTRACT_CHECKS
   * bootstrap-deploy escape hatch (contracts may not exist yet);
   * snapshots carry zero balances but real `lastEvent*` triple.
   */
  readonly skipContractChecks?: boolean;
}

const DEFAULT_REFRESH_MS = 15_000;
const INGOTS_CAP = 64 * 27 * 9;
const USDC_PER_INGOT_RAW = 100_000_000n; // 100 USDC in 6-dec wei

const ZERO: AgentStateSnapshot = {
  lpVaultTotalAssetsUsdc6: "0",
  lpVaultTotalSupplyShares: "0",
  outstandingPrincipalUsdc6: "0",
  activeLoanCount: 0,
  lastEventId: null,
  lastEventType: null,
  lastEventTimestamp: null,
  chestIngotsApprox: 0,
  lpVaultOwner: null,
  loanBookOwner: null,
  fetchedAt: 0,
  stale: true,
};

const OWNER_CACHE_TTL_MS = 60_000;

export function createAgentState(opts: CreateAgentStateOpts): AgentState {
  let cached: AgentStateSnapshot = ZERO;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Track the most-recent event reactively. We do one O(N) tip-walk at
  // start() and then update on every append — the alternative (calling
  // walkFromTip on every 15s tick) reads the whole NDJSON file each
  // time, which scales poorly as the log grows.
  let lastEvId: Sha256Hex | null = null;
  let lastEvType: string | null = null;
  let lastEvTs: number | null = null;
  let unsubscribe: (() => void) | null = null;

  // Demo deposit tracker — see addDemoDepositUsdc6 docstring above.
  let demoDepositsUsdc6 = 0n;

  // Owner cache — refreshed every OWNER_CACHE_TTL_MS. The two `owner()`
  // reads are cheap but unchanging; cache them separately so most ticks
  // skip the calls.
  let cachedLpOwner: `0x${string}` | null = null;
  let cachedLbOwner: `0x${string}` | null = null;
  let cachedOwnerAt = 0;
  function ownerCacheStale(): boolean {
    if (cachedLpOwner === null || cachedLbOwner === null) return true;
    return Date.now() - cachedOwnerAt > OWNER_CACHE_TTL_MS;
  }

  async function fetchOnce(): Promise<AgentStateSnapshot> {
    const lastEvSummary = {
      lastEventId: lastEvId,
      lastEventType: lastEvType,
      lastEventTimestamp: lastEvTs,
    };

    if (opts.skipContractChecks === true) {
      const visibleAssets = demoDepositsUsdc6;
      const ingotsRaw = visibleAssets / USDC_PER_INGOT_RAW;
      const chestIngotsApprox = ingotsRaw > BigInt(INGOTS_CAP)
        ? INGOTS_CAP
        : Number(ingotsRaw);
      cached = {
        ...ZERO,
        ...lastEvSummary,
        lpVaultTotalAssetsUsdc6: visibleAssets.toString(),
        activeLoanCount: opts.activeLoanCount(),
        chestIngotsApprox,
        fetchedAt: Date.now(),
        stale: false,
      };
      return cached;
    }

    try {
      // Owner reads are cached separately (60s TTL) — they only change
      // on a 2-step ownership rotation, not in any normal demo run.
      // Skip the read most ticks to avoid four chain calls per cycle.
      const ownerRead = ownerCacheStale()
        ? Promise.all([
            opts.publicClient.readContract({
              address: opts.lpVaultAddress,
              abi: LP_VAULT_STATE_ABI,
              functionName: "owner",
            }) as Promise<`0x${string}`>,
            opts.publicClient.readContract({
              address: opts.loanBookAddress,
              abi: LOAN_BOOK_STATE_ABI,
              functionName: "owner",
            }) as Promise<`0x${string}`>,
          ]).then(([lp, lb]) => {
            cachedLpOwner = lp;
            cachedLbOwner = lb;
            cachedOwnerAt = Date.now();
            return [lp, lb] as const;
          }, () => [cachedLpOwner, cachedLbOwner] as const)
        : Promise.resolve([cachedLpOwner, cachedLbOwner] as const);

      const [totalAssets, totalSupply, outstandingPrincipal, [lpOwner, lbOwner]] = await Promise.all([
        opts.publicClient.readContract({
          address: opts.lpVaultAddress,
          abi: LP_VAULT_STATE_ABI,
          functionName: "totalAssets",
        }) as Promise<bigint>,
        opts.publicClient.readContract({
          address: opts.lpVaultAddress,
          abi: LP_VAULT_STATE_ABI,
          functionName: "totalSupply",
        }) as Promise<bigint>,
        opts.publicClient.readContract({
          address: opts.loanBookAddress,
          abi: LOAN_BOOK_STATE_ABI,
          functionName: "outstandingPrincipal",
        }) as Promise<bigint>,
        ownerRead,
      ]);

      // Visible vault = on-chain assets + narrated demo deposits.
      // When the demo wires through to a real LpVault.deposit() call,
      // demoDepositsUsdc6 stays at 0 and this is just totalAssets.
      const visibleAssets = totalAssets + demoDepositsUsdc6;
      const ingotsRaw = visibleAssets / USDC_PER_INGOT_RAW;
      const chestIngotsApprox = ingotsRaw > BigInt(INGOTS_CAP)
        ? INGOTS_CAP
        : Number(ingotsRaw);

      cached = {
        lpVaultTotalAssetsUsdc6: visibleAssets.toString(),
        lpVaultTotalSupplyShares: totalSupply.toString(),
        outstandingPrincipalUsdc6: outstandingPrincipal.toString(),
        activeLoanCount: opts.activeLoanCount(),
        ...lastEvSummary,
        chestIngotsApprox,
        lpVaultOwner: lpOwner ?? null,
        loanBookOwner: lbOwner ?? null,
        fetchedAt: Date.now(),
        stale: false,
      };
      return cached;
    } catch {
      // Mark cached as stale and return last-known. Never throw —
      // callers depend on getting *some* snapshot, even an old one,
      // because the wizard would rather be quiet about state than
      // make up new numbers.
      cached = {
        ...cached,
        ...lastEvSummary,
        activeLoanCount: opts.activeLoanCount(),
        stale: true,
      };
      return cached;
    }
  }

  return {
    snapshot: () => cached,
    start: () => {
      if (timer !== null) return;
      // One-shot tip-walk to seed the most-recent-event triple. After
      // this, we update reactively via log.onAppend; no further file
      // reads on the lastEv* fields.
      void (async () => {
        const lastEv = await readLastEvent(opts.log);
        if (lastEv !== null) {
          lastEvId = lastEv.id;
          lastEvType = lastEv.type;
          lastEvTs = lastEv.timestamp;
        }
        unsubscribe = opts.log.onAppend((ev) => {
          lastEvId = ev.id;
          lastEvType = ev.type;
          lastEvTs = ev.timestamp;
        });
        await fetchOnce();
      })();
      timer = setInterval(() => {
        void fetchOnce();
      }, opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS);
      timer.unref?.();
    },
    stop: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    },
    refreshNow: () => fetchOnce(),
    addDemoDepositUsdc6: (raw6: bigint) => {
      const next = demoDepositsUsdc6 + raw6;
      demoDepositsUsdc6 = next < 0n ? 0n : next; // floor at zero
      // Force a refresh so the chest renderer picks up the new total
      // on its next 30s poll without waiting for the agent-state's
      // own 15s timer to roll around.
      void fetchOnce();
    },
  };
}

async function readLastEvent(
  log: FileEventLog,
): Promise<{ id: Sha256Hex; type: string; timestamp: number } | null> {
  for await (const ev of log.walkFromTip()) {
    return { id: ev.id, type: ev.type, timestamp: ev.timestamp };
  }
  return null;
}
