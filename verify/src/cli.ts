/**
 * `vanta-verify <url>` — third-party verifier entry point.
 *
 * Steps:
 *   1. Fetch `/api/tee` → signing pubkey.
 *   2. Fetch `/api/constitution` → expected constitution hash.
 *   3. Walk the event DAG from `--event` back to genesis, verifying
 *      every signature and (when `--rpc + --loan-book` are provided)
 *      cross-checking on-chain `LoanBook.loans(loanId).paramsHash`
 *      against each `loan.origination`'s `params_hash`.
 *
 * Exit codes:
 *   - 0  verification passed.
 *   - 1  verification failure (any signature, any params_hash, any
 *         genesis-hash mismatch, any chain_too_deep).
 *   - 2  usage or network error (CLI flag missing/invalid, fetch
 *         failed pre-walk, RPC unreachable for the on-chain cross
 *         check).
 *
 * `--json` flips output to a single JSON line for CI.
 *
 * `--fixture <path>` is an internal opt-in that swaps the HTTP fetcher
 * for an in-process fixture loader. The selftest script uses it to
 * smoke-test the package without requiring a running VANTA agent.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { Command } from "commander";

import type { SigningPubKeyHex, VantaEvent } from "@vanta/events";
import { asSigningPubKeyHex } from "@vanta/tee";

import { VerifyError } from "./errors.js";
import {
  fetchConstitution,
  fetchEvent as fetchEventHttp,
  fetchTee,
} from "./fetch.js";
import {
  buildPublicClient,
  fetchLoanParamsHash as fetchLoanParamsHashOnChain,
} from "./onchain.js";
import { formatHuman, formatJson } from "./output.js";
import {
  defaultVerifyAdapter,
  walkChain,
  type WalkDeps,
} from "./walk.js";

export interface CliOptions {
  /** Argv minus the leading `node` + script-path entries. */
  readonly argv: readonly string[];
  /** Where to print output to. Tests inject a buffer. */
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
}

export interface FixtureManifest {
  /** Map from event id → signed event JSON. */
  readonly events: Readonly<Record<string, VantaEvent>>;
  /** Map from loan id → on-chain params_hash (or null). */
  readonly loans: Readonly<Record<string, string | null>>;
  /** /api/tee shape. */
  readonly tee: {
    readonly signingPubKey: string;
    readonly attestationJwt: string;
    readonly active: boolean;
    readonly tipEventId?: string;
  };
  /** /api/constitution shape. */
  readonly constitution: {
    readonly hash: string;
    readonly body: unknown;
  };
}

async function loadFixture(fixturePath: string): Promise<FixtureManifest> {
  const abs = path.isAbsolute(fixturePath)
    ? fixturePath
    : path.resolve(process.cwd(), fixturePath);
  const raw = await fs.readFile(abs, "utf8");
  return JSON.parse(raw) as FixtureManifest;
}

/**
 * Programmatic entry point. Returns the process exit code (0 / 1 / 2)
 * the CLI would emit. Tests call this directly with a captured
 * stdout buffer; the binary shim wraps a `process.exit` around it.
 */
export async function runCli(opts: CliOptions): Promise<number> {
  const program = new Command();
  program
    .name("vanta-verify")
    .description(
      "Walk a VANTA event chain back to genesis, verifying every signature " +
        "and cross-checking on-chain LoanBook.loans(loanId).paramsHash for " +
        "each loan.origination event.",
    )
    .argument("<url>", "VANTA agent base URL (e.g. https://vanta.example)")
    .requiredOption(
      "--event <id>",
      "starting event id (64-char lowercase hex)",
    )
    .option("--json", "emit a single line of JSON instead of human output")
    .option(
      "--rpc <url>",
      "Base Sepolia RPC URL for on-chain params_hash cross-check",
    )
    .option(
      "--loan-book <addr>",
      "LoanBook contract address (required if --rpc is set)",
    )
    .option(
      "--fixture <path>",
      "use a JSON fixture file instead of HTTP (internal selftest)",
    )
    .exitOverride()
    .configureOutput({
      writeOut: (s) => opts.stdout(s),
      writeErr: (s) => opts.stderr(s),
    });

  let parsed: { args: string[]; opts: Record<string, unknown> };
  try {
    program.parse([...opts.argv], { from: "user" });
    parsed = {
      args: program.args,
      opts: program.opts(),
    };
  } catch (cause: unknown) {
    opts.stderr(
      `vanta-verify: usage error — ${
        cause instanceof Error ? cause.message : "unknown"
      }\n`,
    );
    return 2;
  }

  const baseUrl = parsed.args[0];
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    opts.stderr("vanta-verify: missing positional <url>\n");
    return 2;
  }

  const eventStartId = String(parsed.opts["event"] ?? "");
  if (!/^[0-9a-f]{64}$/.test(eventStartId)) {
    opts.stderr(
      "vanta-verify: --event must be 64-char lowercase hex (no 0x prefix)\n",
    );
    return 2;
  }

  const useJson = parsed.opts["json"] === true;
  const rpcUrl = parsed.opts["rpc"] as string | undefined;
  const loanBookAddr = parsed.opts["loanBook"] as string | undefined;
  const fixturePath = parsed.opts["fixture"] as string | undefined;

  if (rpcUrl !== undefined && loanBookAddr === undefined) {
    opts.stderr(
      "vanta-verify: --rpc requires --loan-book to be set\n",
    );
    return 2;
  }

  // ---- Bind fetchers (HTTP or fixture) ------------------------------------
  let teeRes;
  let constitutionRes;
  let fetchEvent: (id: string) => Promise<VantaEvent>;
  let fetchLoanHash: (loanId: string) => Promise<string | null>;
  let onChainEnabled = false;

  if (fixturePath !== undefined) {
    let manifest: FixtureManifest;
    try {
      manifest = await loadFixture(fixturePath);
    } catch (cause: unknown) {
      opts.stderr(
        `vanta-verify: fixture read failed — ${
          cause instanceof Error ? cause.message : "unknown"
        }\n`,
      );
      return 2;
    }
    teeRes = manifest.tee;
    constitutionRes = manifest.constitution;
    fetchEvent = async (id: string): Promise<VantaEvent> => {
      const ev = manifest.events[id];
      if (ev === undefined) {
        throw new VerifyError(
          "parent_missing",
          `fixture has no event for id ${id}`,
          { id },
        );
      }
      return ev;
    };
    fetchLoanHash = async (loanId: string): Promise<string | null> => {
      const v = manifest.loans[loanId];
      return v === undefined ? null : v;
    };
    // Fixture mode always evaluates the on-chain check; loans table
    // stands in for the LoanBook read.
    onChainEnabled = true;
  } else {
    try {
      teeRes = await fetchTee(baseUrl);
      constitutionRes = await fetchConstitution(baseUrl);
    } catch (cause: unknown) {
      opts.stderr(
        `vanta-verify: pre-walk fetch failed — ${
          cause instanceof Error ? cause.message : "unknown"
        }\n`,
      );
      return 2;
    }
    fetchEvent = async (id: string): Promise<VantaEvent> => {
      const raw = await fetchEventHttp(baseUrl, id);
      return raw as unknown as VantaEvent;
    };
    if (rpcUrl !== undefined && loanBookAddr !== undefined) {
      const client = buildPublicClient(rpcUrl);
      const addr = loanBookAddr as `0x${string}`;
      fetchLoanHash = async (loanId: string): Promise<string | null> =>
        fetchLoanParamsHashOnChain(client, addr, loanId);
      onChainEnabled = true;
    } else {
      fetchLoanHash = async (_id: string): Promise<string | null> => null;
      onChainEnabled = false;
      opts.stderr(
        "vanta-verify: WARNING — no --rpc supplied; skipping on-chain params_hash cross-check\n",
      );
    }
  }

  let signer: SigningPubKeyHex;
  try {
    signer = asSigningPubKeyHex(teeRes.signingPubKey);
  } catch (cause: unknown) {
    opts.stderr(
      `vanta-verify: /api/tee.signingPubKey is malformed — ${
        cause instanceof Error ? cause.message : "unknown"
      }\n`,
    );
    return 2;
  }

  const deps: WalkDeps = {
    fetchEvent,
    verifyEvent: defaultVerifyAdapter,
    fetchLoanParamsHash: fetchLoanHash,
    expectedConstitutionHash: constitutionRes.hash,
    signer,
    enableOnChainCheck: onChainEnabled,
  };

  const result = await walkChain(deps, eventStartId);
  const summary = {
    url: baseUrl,
    startEventId: eventStartId,
    result,
  };
  opts.stdout((useJson ? formatJson(summary) : formatHuman(summary)) + "\n");

  return result.ok && result.errors.length === 0 ? 0 : 1;
}

/**
 * Shim entry point used by the `bin` shim. Reads `process.argv` and
 * exits with the resolved code.
 */
export async function main(): Promise<void> {
  const code = await runCli({
    argv: process.argv.slice(2),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(code);
}

// Auto-run when executed as a script (the bin shim re-exports this
// module). Detect by checking if this is the entrypoint module.
const isEntry =
  process.argv[1] !== undefined &&
  /cli\.js$/.test(process.argv[1]);
if (isEntry) {
  void main();
}
