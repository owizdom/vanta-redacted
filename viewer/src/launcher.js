// VANTA launcher. Single-page hash-routed SPA over the live world
// iframe. State lives in `state` below; screens are HTML siblings
// hidden/shown via the `hidden` attribute. The world iframe is
// mounted exactly once and never unmounted — transitions are pure
// CSS class swaps.

import {
  truncateHex,
  formatUsdc6,
  escapeHtml as esc,
  BASESCAN_TX_BASE,
  BASESCAN_BLOCK_BASE,
  POLYMARKET_BASE,
} from '/util.js';

// Role tiles — replaces the old skin/robe pickers. The bridge plugin
// ignores skin/robeColor today (tower is a wood obelisk + armor stand,
// not a Mineflayer player), so we don't pretend the visitor's robe
// shows up in-world. Role is a soft annotation: it changes how VANTA
// addresses the counterparty in chat, nothing else.
const ROLES = [
  { id: 'lender',   label: 'lender',   blurb: "I'm depositing into the LP vault" },
  { id: 'borrower', label: 'borrower', blurb: 'I want a signed quote' },
  { id: 'verifier', label: 'verifier', blurb: "I'm just watching" },
];

// Default skin/robeColor we still POST so the runtime's existing
// /open/spawn-demo schema doesn't reject the request. The runtime
// stores them but the visual layer ignores them.
const DEFAULT_SKIN = 'classic-blue';
const DEFAULT_ROBE = 'blue';

const state = {
  paymentVerified: false,
  txHash: null,
  bypassChecked: false,
  spawn: {
    chatName: '',
    role: 'borrower',
  },
  spawnResult: null,
};

const SCREEN_IDS = [
  'title', 'mode', 'about',
  'spawn-pay', 'spawn-customize', 'spawn-play', 'spawn-receipt',
  'console',
];
const HASH_TO_SCREEN = {
  '#/title': 'title',
  '': 'title',
  '#/mode': 'mode',
  '#/about': 'about',
  '#/spawn/pay': 'spawn-pay',
  '#/spawn/customize': 'spawn-customize',
  '#/spawn/play': 'spawn-play',
  '#/spawn/receipt': 'spawn-receipt',
  '#/console': 'console',
};

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', () => {
  renderRoles();
  hookGlobalNav();
  hookPayStep();
  hookCustomizeStep();
  hookPlayStep();
  hookOnlineCount();
  hookHeroCard();
  route();
  window.addEventListener('hashchange', route);
});

// ---------- Routing ----------
function route() {
  const hash = window.location.hash;
  let screen = HASH_TO_SCREEN[hash];
  if (screen === undefined) screen = 'title';

  // Guard: cannot enter customize/play without paymentVerified.
  if (
    (screen === 'spawn-customize' || screen === 'spawn-play') &&
    !state.paymentVerified
  ) {
    window.location.hash = '#/spawn/pay';
    return;
  }
  // Guard: cannot enter play without a valid customize.
  if (screen === 'spawn-play' && !customizeValid()) {
    window.location.hash = '#/spawn/customize';
    return;
  }

  document.body.classList.toggle('is-console', screen === 'console');
  for (const id of SCREEN_IDS) {
    const el = document.getElementById('screen-' + id);
    if (!el) continue;
    if (id === screen) {
      el.removeAttribute('hidden');
    } else {
      el.setAttribute('hidden', '');
    }
  }
  // Per-screen mount hooks.
  if (screen === 'spawn-pay') resetPayStep();
  if (screen === 'spawn-play') renderRecap();
  if (screen === 'spawn-receipt') renderReceipt();
  if (screen === 'about') hookAboutTiles();
  // Cancel the auto-advance countdown if user navigates away from receipt.
  if (screen !== 'spawn-receipt' && state._receiptTimer) {
    clearInterval(state._receiptTimer);
    state._receiptTimer = null;
  }
  if (screen !== 'spawn-receipt' && state._moneyTimer) {
    clearInterval(state._moneyTimer);
    state._moneyTimer = null;
  }
}

// Whenever the user lands on Step 1, blow away any prior payment
// state — re-running the flow always produces a fresh tower. If the
// bypass is already checked, drop a new random hash into the field.
function resetPayStep() {
  state.paymentVerified = false;
  state.txHash = null;
  state.spawnResult = null;
  const tx = document.getElementById('txHash');
  const bypass = document.getElementById('bypass');
  const next = document.getElementById('next-pay');
  const status = document.getElementById('pay-status');
  if (next) next.setAttribute('disabled', '');
  if (status) {
    status.textContent = '';
    status.className = 'pay-status';
  }
  if (tx && bypass && bypass.checked) {
    tx.value = randomTxHash();
  }
}

function hookGlobalNav() {
  document.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-nav]');
    if (!target) return;
    const dest = target.getAttribute('data-nav');
    if (dest === 'exit') {
      window.close();
      // window.close only works for windows opened by script; show fallback toast.
      setTimeout(() => {
        toast('close this tab to leave the town', 'ok');
      }, 80);
      return;
    }
    if (typeof dest === 'string' && dest.startsWith('#/')) {
      // Cancel the click + use replaceState/pushState for the hash so
      // browser back-button keeps working. Plain `location.hash = …`
      // also works but pushes a duplicate when re-clicking.
      ev.preventDefault();
      if (window.location.hash !== dest) {
        window.location.hash = dest;
      }
    }
  });
}

// ---------- Online HUD ----------
async function hookOnlineCount() {
  async function tick() {
    try {
      const r = await fetch('/api/town/state', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const total = d.totalOnline || 1;
      const label = total === 1 ? '1 wizard online' : (total + ' wizards online');
      document.getElementById('hud-online').textContent = label;
    } catch (_) {}
  }
  tick();
  setInterval(tick, 8000);
}

// ---------- Hero card (live company state on title screen) ----------
// Polls /api/vault/state (proxied to runtime /bridge/vault/state), fills
// three live cells. The runtime polls the on-chain LpVault.totalAssets()
// + LoanBook.outstandingPrincipal() every 15s, so this is real chain data.
async function hookHeroCard() {
  async function tick() {
    try {
      const r = await fetch('/api/vault/state', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const aum = document.getElementById('hero-aum');
      const loans = document.getElementById('hero-loans');
      const last = document.getElementById('hero-last');
      const lastLabel = document.getElementById('hero-last-label');
      const stale = !!d.stale;
      if (aum) {
        const n = Number(d.lp_vault_total_assets_usdc6 || '0') / 1_000_000;
        aum.textContent = '$' + Math.round(n).toLocaleString('en-US');
        aum.classList.toggle('is-stale', stale);
      }
      if (loans) {
        loans.textContent = String(d.active_loan_count ?? 0);
        loans.classList.toggle('is-stale', stale);
      }
      if (last && lastLabel) {
        const ts = Number(d.last_event_timestamp_unix || 0);
        if (ts > 0) {
          const ago = Math.max(0, Math.floor(Date.now() / 1000 - ts));
          last.textContent = humanAgo(ago);
          last.classList.toggle('is-stale', stale);
          const t = String(d.last_event_type || 'event');
          if (t === 'loan.settlement' || t === 'loan.liquidation') {
            lastLabel.textContent = 'last settlement';
          } else if (t === 'treasury.inflow') {
            lastLabel.textContent = 'last inflow';
          } else if (t === 'loan.origination') {
            lastLabel.textContent = 'last origination';
          } else {
            lastLabel.textContent = 'last event';
          }
        } else {
          last.textContent = '—';
          lastLabel.textContent = 'last event';
        }
      }
    } catch (_) {}
  }
  tick();
  setInterval(tick, 8000);
}

function humanAgo(secs) {
  if (secs < 60) return secs + 's ago';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

// ---------- About tiles ----------
// Populates tile 2's owner address from /api/identity-pin (live TEE EOA),
// and tile 3's "view recent X402 settlement" link from the latest
// treasury.inflow event. Both are best-effort; if either fetch fails the
// hardcoded fallbacks remain in place.
async function hookAboutTiles() {
  try {
    const r = await fetch('/api/identity-pin', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      const addr = d.tee_address;
      if (addr) {
        const span = document.getElementById('tile-owner-addr');
        const link = document.getElementById('tile-owner-link');
        if (span) span.textContent = truncateHex(addr, 6, 4);
        if (link) link.href = 'https://sepolia.basescan.org/address/' + addr;
      }
    }
  } catch (_) {}
  try {
    const r = await fetch('/api/events?limit=1&type=treasury.inflow', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      const ev = Array.isArray(d?.events) ? d.events[0] : null;
      const txHash = ev?.body?.txHash;
      if (typeof txHash === 'string' && /^[0-9a-f]{64}$/.test(txHash)) {
        const link = document.getElementById('tile-inflow-link');
        if (link) link.href = BASESCAN_TX_BASE + '0x' + txHash;
      }
    }
  } catch (_) {}
}

// ---------- Role tiles ----------
function renderRoles() {
  const tiles = document.getElementById('role-tiles');
  if (!tiles) return;
  tiles.innerHTML = ROLES.map((r) => (
    '<button class="role-tile' + (r.id === state.spawn.role ? ' is-selected' : '') + '"'
    + ' data-role="' + r.id + '" type="button">'
    + '<div class="role-tile-label">' + r.label + '</div>'
    + '<div class="role-tile-blurb">' + r.blurb + '</div>'
    + '</button>'
  )).join('');
  tiles.addEventListener('click', (ev) => {
    const tile = ev.target.closest('[data-role]');
    if (!tile) return;
    state.spawn.role = tile.getAttribute('data-role');
    tiles.querySelectorAll('.role-tile').forEach((t) => t.classList.remove('is-selected'));
    tile.classList.add('is-selected');
    refreshCustomizeNext();
  });
}

// ---------- Step 1: Pay ----------
function hookPayStep() {
  const verify = document.getElementById('verify-btn');
  const tx = document.getElementById('txHash');
  const bypass = document.getElementById('bypass');
  const next = document.getElementById('next-pay');
  if (!verify || !tx || !next) return;

  verify.addEventListener('click', async () => {
    const v = (tx.value || '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
      setPayStatus('paste a 0x + 64-hex tx hash', 'err');
      return;
    }
    setPayStatus('checking on-chain receipt…', 'checking');
    state.bypassChecked = !!(bypass && bypass.checked);
    try {
      const r = await fetch('/api/verify-payment', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(state.bypassChecked
            ? { 'x-vanta-internal': 'local-dev-secret-do-not-use-in-prod' }
            : {}),
        },
        body: JSON.stringify({ txHash: v.toLowerCase() }),
      });
      const data = await r.json().catch(() => ({}));
      if (state.bypassChecked) {
        // The bypass header makes /open/payment return ok=true with bypass:true;
        // even if the proxy didn't pass through the header (older runtime),
        // we accept locally because the local-anvil flow has no real receipt.
        state.paymentVerified = true;
        state.txHash = v.toLowerCase();
        setPayStatus('local-anvil bypass — proceed', 'ok');
        next.removeAttribute('disabled');
        return;
      }
      if (data.ok) {
        const usdc = (Number(data.amountUsdc6 || '0') / 1_000_000).toFixed(6);
        state.paymentVerified = true;
        state.txHash = v.toLowerCase();
        setPayStatus('verified · ' + usdc + ' USDC received', 'ok');
        next.removeAttribute('disabled');
      } else {
        setPayStatus(humanError(data.error) || 'payment not found', 'err');
      }
    } catch (e) {
      setPayStatus('runtime unreachable: ' + e.message, 'err');
    }
  });

  // Auto-fill a fresh random tx hash whenever the bypass box is
  // ticked. Always replaces — re-checking after a successful spawn
  // gives you a brand-new hash so the runtime's idempotent-on-
  // txHash path doesn't return your previous tower.
  if (bypass) {
    bypass.addEventListener('change', () => {
      if (bypass.checked) {
        tx.value = randomTxHash();
      }
    });
  }
}

function randomTxHash() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return '0x' + Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function setPayStatus(msg, kind) {
  const el = document.getElementById('pay-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pay-status' + (kind ? ' is-' + kind : '');
}

// ---------- Step 2: Customize ----------
function hookCustomizeStep() {
  const name = document.getElementById('chatName');
  if (!name) return;
  name.addEventListener('input', () => {
    state.spawn.chatName = name.value;
    const ok = customizeValid();
    name.setCustomValidity(ok || /^[A-Za-z0-9]{0,24}$/.test(name.value)
      ? '' : 'use 1-24 letters or numbers');
    refreshCustomizeNext();
  });
}

function customizeValid() {
  return /^[A-Za-z0-9]{1,24}$/.test(state.spawn.chatName)
    && !!state.spawn.role;
}

function refreshCustomizeNext() {
  const next = document.getElementById('next-customize');
  if (!next) return;
  if (customizeValid()) next.removeAttribute('disabled');
  else next.setAttribute('disabled', '');
}

// ---------- Step 3: Play ----------
function renderRecap() {
  const recap = document.getElementById('recap');
  if (!recap) return;
  const role = ROLES.find((r) => r.id === state.spawn.role);
  recap.innerHTML =
    '<div class="recap-meta">'
      + '<span class="label">handle</span>'
      + '<span class="value">' + esc(state.spawn.chatName) + '</span>'
      + '<span class="label" style="margin-top:6px">role</span>'
      + '<span class="value">' + (role ? role.label : '-') + ' · ' + (role ? role.blurb : '') + '</span>'
    + '</div>';
}

function hookPlayStep() {
  const btn = document.getElementById('spawn-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.setAttribute('disabled', '');
    setSpawnStatus('signing registration…', 'spawning');
    try {
      const r = await fetch('/api/spawn', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(state.bypassChecked
            ? { 'x-vanta-internal': 'local-dev-secret-do-not-use-in-prod' }
            : {}),
        },
        body: JSON.stringify({
          chatName: state.spawn.chatName,
          // skin/robeColor kept at defaults so the runtime schema is
          // happy; the bridge plugin doesn't render either today, so
          // we don't pretend they affect the in-world tower.
          skin: DEFAULT_SKIN,
          robeColor: DEFAULT_ROBE,
          role: state.spawn.role,
          txHash: state.txHash,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.ok) {
        state.spawnResult = data;
        // Pre-fetch the issuer pubkey + treasury address so the receipt
        // card renders immediately without an async hole.
        state.x402 = await fetchX402Info();
        if (data.idempotent) {
          // The runtime returned an existing tower for this txHash.
          // Surface it loudly so the user doesn't think their new
          // chatName/colors took effect — they didn't.
          setSpawnStatus(
            'this tx hash already claimed tower #' + data.plotIndex
              + ' — your inputs were ignored',
            'err',
          );
          toast('this tx hash is already used; tick "local-anvil demo" again for a fresh hash', 'err');
          btn.removeAttribute('disabled');
          return;
        }
        setSpawnStatus('tower #' + data.plotIndex + ' claimed', 'ok');
        window.location.hash = '#/spawn/receipt';
      } else {
        setSpawnStatus(humanError(data.error) || 'spawn failed', 'err');
        btn.removeAttribute('disabled');
      }
    } catch (e) {
      setSpawnStatus('runtime unreachable: ' + e.message, 'err');
      btn.removeAttribute('disabled');
    }
  });
}

function setSpawnStatus(msg, kind) {
  const el = document.getElementById('spawn-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'spawn-status' + (kind ? ' is-' + kind : '');
}

// ---------- Receipt step ----------
async function fetchX402Info() {
  try {
    const r = await fetch('/api/x402-info', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

async function fetchAttestation() {
  try {
    const r = await fetch('/api/attestation', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

async function renderReceipt() {
  const card = document.getElementById('receipt-card');
  const banner = document.getElementById('receipt-bypass-banner');
  const cd = document.getElementById('receipt-countdown');
  const verifyRow = document.getElementById('receipt-verify-row');
  const economics = document.getElementById('receipt-economics');
  const moneyCd = document.getElementById('receipt-money-countdown');
  if (!card || !cd) return;
  const sp = state.spawnResult;
  if (!sp) {
    // Direct nav to /spawn/receipt without state — bounce home.
    window.location.hash = '#/title';
    return;
  }

  const isBypass = !!sp.bypass;
  if (banner) banner.toggleAttribute('hidden', !isBypass);

  // Pre-fetch attestation so the enclave row can render without an
  // async hole. fetchX402Info already ran in hookPlayStep on spawn.
  const attest = await fetchAttestation();

  const inflow = sp.inflow;
  const txHashRaw = inflow?.body?.txHash ?? state.txHash?.replace(/^0x/, '') ?? '';
  const txHashWith0x = '0x' + txHashRaw;
  const fromAddr = inflow?.body?.fromAddr ?? '0x0000000000000000000000000000000000000000';
  const toAddr = inflow?.body?.toAddr ?? (state.x402?.receiver ?? '0x0000000000000000000000000000000000000000');
  const amount = inflow?.body?.amount ?? '50000';
  const eventId = inflow?.id ?? '0'.repeat(64);
  const blockNumber = inflow?.body?.blockNumber ?? null;
  const issuer = state.x402?.issuer_pubkey ?? null;
  const enclaveHash = attest?.enclave_identity_hash ?? null;
  const basescanLink = BASESCAN_TX_BASE + txHashWith0x;
  const blockLink = blockNumber !== null ? (BASESCAN_BLOCK_BASE + blockNumber) : null;
  const linkAttrs = isBypass
    ? 'title="bypass receipt — won\'t resolve on basescan"'
    : 'target="_blank" rel="noopener"';

  const usdcDisplay = formatUsdc6(amount);
  // Strip trailing zero-padding for readability (0.050000 → 0.05).
  const usdcPretty = usdcDisplay.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

  card.innerHTML =
    '<div class="receipt-row receipt-amount">'
      + '<span class="r-label">paid</span>'
      + '<span class="r-value-big">' + esc(usdcPretty) + ' USDC</span>'
    + '</div>'
    + '<div class="receipt-row">'
      + '<span class="r-label">tower</span>'
      + '<span class="r-value">#' + sp.plotIndex + ' · plot (' + sp.plotX + ', ' + sp.plotZ + ')</span>'
    + '</div>'
    + '<div class="receipt-row">'
      + '<span class="r-label">from</span>'
      + '<span class="r-value mono" title="' + esc(fromAddr) + '">' + esc(truncateHex(fromAddr, 6, 4)) + '</span>'
    + '</div>'
    + '<div class="receipt-row">'
      + '<span class="r-label">to</span>'
      + '<span class="r-value mono" title="' + esc(toAddr) + '">' + esc(truncateHex(toAddr, 6, 4)) + ' · vanta-treasury-v1</span>'
    + '</div>'
    + '<div class="receipt-row">'
      + '<span class="r-label">tx</span>'
      + '<a class="r-value mono r-link" href="' + esc(basescanLink) + '" ' + linkAttrs + '>'
        + esc(truncateHex(txHashWith0x, 8, 6)) + ' ↗</a>'
    + '</div>'
    + (blockLink !== null
      ? '<div class="receipt-row">'
          + '<span class="r-label">block</span>'
          + '<a class="r-value mono r-link" href="' + esc(blockLink) + '" ' + linkAttrs + '>#' + blockNumber + ' ↗</a>'
        + '</div>'
      : '')
    + '<div class="receipt-row">'
      + '<span class="r-label">event id</span>'
      + '<span class="r-value mono" title="' + esc(eventId) + '">' + esc(truncateHex('0x' + eventId, 8, 6)) + '</span>'
    + '</div>'
    + '<div class="receipt-row receipt-signed">'
      + '<span class="r-label">signed by</span>'
      + '<span class="r-value mono" title="' + esc(issuer ?? '(unavailable)') + '">'
        + (issuer ? 'VANTA · ed25…' + esc(issuer.slice(-4)) : '—')
      + '</span>'
    + '</div>'
    + '<div class="receipt-row">'
      + '<span class="r-label">enclave</span>'
      + '<span class="r-value mono" title="' + esc(enclaveHash ?? '(unavailable)') + '">'
        + (enclaveHash ? esc(truncateHex('0x' + enclaveHash, 8, 6)) : '—')
      + '</span>'
    + '</div>';

  // Three verify links. On bypass we render them but flag them with a
  // title attr so the user knows the basescan link is synthetic.
  if (verifyRow) {
    verifyRow.innerHTML =
      '<a class="receipt-verify-link" href="' + esc(basescanLink) + '" ' + linkAttrs + '>'
      + 'verify the payment ↗</a>'
      + '<a class="receipt-verify-link" href="/api/attestation" target="_blank" rel="noopener">'
      + 'verify the enclave ↗</a>'
      + '<a class="receipt-verify-link" href="https://github.com/owizdom/vanta" target="_blank" rel="noopener">'
      + 'verify the source ↗</a>';
  }

  // Economics line — structurally true (we have amount; we know the
  // agent pays its own inference). No fabricated runway aggregate.
  if (economics) {
    economics.textContent =
      'VANTA earned ' + usdcPretty + ' USDC. Net to treasury after inference cost: ~'
      + (Math.max(0, parseFloat(usdcPretty || '0') - 0.012)).toFixed(3)
      + '. The agent paid its own LLM bill from this payment.';
  }

  // Follow-the-money countdown (4-3-2-1 then "spent on inference").
  // Renders one short-cycle timer that reinforces the self-funding loop
  // at the moment the user feels strongest "what did I just do?" reflex.
  if (moneyCd) {
    let mTick = 4;
    moneyCd.textContent = 'your ' + usdcPretty + ' USDC has lived in the treasury for ' + mTick + 's…';
    if (state._moneyTimer) clearInterval(state._moneyTimer);
    state._moneyTimer = setInterval(() => {
      mTick -= 1;
      if (mTick <= 0) {
        clearInterval(state._moneyTimer);
        state._moneyTimer = null;
        moneyCd.textContent =
          '↳ in the next 30s VANTA will spend ~0.012 of it on inference. you are now its smallest shareholder.';
      } else {
        moneyCd.textContent =
          'your ' + usdcPretty + ' USDC has lived in the treasury for ' + mTick + 's…';
      }
    }, 1000);
  }

  // Auto-advance to /console after 12s. Bumped from 6s so the new
  // copy density actually has time to land. Cleared by route() if the
  // user navigates manually.
  let secs = 12;
  cd.textContent = 'auto-entering in ' + secs + 's…';
  if (state._receiptTimer) clearInterval(state._receiptTimer);
  state._receiptTimer = setInterval(() => {
    secs -= 1;
    if (secs <= 0) {
      clearInterval(state._receiptTimer);
      state._receiptTimer = null;
      if (window.location.hash === '#/spawn/receipt') {
        window.location.hash = '#/console';
      }
    } else {
      cd.textContent = 'auto-entering in ' + secs + 's…';
    }
  }, 1000);
}

// ---------- Helpers ----------
function humanError(code) {
  return ({
    payment_not_found: 'no payment found for that tx hash',
    plots_exhausted: 'all third-party plots are taken (cap is 13)',
    request_invalid: 'request invalid; check your inputs',
    tx_hash_invalid: 'tx hash must be 0x + 64 hex',
    runtime_unreachable: 'runtime unreachable',
  })[code] || code || '';
}

// (escapeHtml lives in /util.js, imported as `esc` at the top.)

let toastTimer = null;
function toast(msg, kind) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' is-' + kind : '');
  el.removeAttribute('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.setAttribute('hidden', '');
  }, 4000);
}

// ---------- Quote widget (title screen) ----------
// Visitor lands on the title screen, picks a Polymarket market from the
// live watched-markets cache, and presses "get signed quote". The
// runtime returns a real haircut + max loan + an inference receipt
// (provider, model, op.inference event id). The result panel shows the
// numbers, the wizard's one-line explanation, and a click-to-verify
// link that opens the signed event by id. The protagonist hook —
// visitors stop being spectators in 2 seconds.
async function hookQuoteWidget() {
  const widget = document.getElementById('quote-widget');
  if (!widget) return;
  const select = document.getElementById('quote-market');
  const btn = document.getElementById('quote-btn');
  const result = document.getElementById('quote-result');
  if (!select || !btn || !result) return;

  // Populate the dropdown from /api/markets/watched. Stale-tolerant: we
  // populate on first load; if the runtime is unreachable we fall back
  // to a tiny hard-coded list so the widget is never visibly broken.
  let markets = [];
  try {
    const r = await fetch('/api/markets/watched', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      markets = Array.isArray(d.markets) ? d.markets : [];
    }
  } catch (_) {
    // network down — fall back below
  }
  if (markets.length === 0) {
    markets = [
      { conditionIdWith0x: '0x1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9',
        question: 'Will Andy Beshear win the 2028 Democratic presidential nomination?', short_name: 'Beshear-2028' },
    ];
  }
  // Render <option>s, sorted by owner_bot first (those have richer context).
  const sorted = [...markets].sort((a, b) => {
    const aw = a.owner_bot ? 0 : 1;
    const bw = b.owner_bot ? 0 : 1;
    return aw - bw;
  });
  for (const m of sorted) {
    const cid = m.conditionIdWith0x || ('0x' + (m.conditionId || ''));
    const label = m.short_name
      ? `${m.short_name}${m.owner_bot ? ' · ' + m.owner_bot + "'s position" : ''}`
      : (m.question || cid).slice(0, 60);
    const opt = document.createElement('option');
    opt.value = cid;
    opt.textContent = label;
    select.appendChild(opt);
  }

  // Quick free-text mode: a leading "0x"-prefixed 64-hex paste also works.
  // We don't add a separate input field to keep the UI tight; users can
  // paste into the select via keyboard? No, can't paste into <select>.
  // Skip free-text for now — the curated list is enough.

  btn.addEventListener('click', async () => {
    const cid = select.value;
    if (!cid) {
      result.removeAttribute('hidden');
      result.innerHTML = '<div class="quote-error">pick a market first</div>';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'asking the wizard…';
    result.removeAttribute('hidden');
    result.innerHTML = '<div class="quote-error" style="color:var(--fg-dim);font-style:italic">requesting signed quote…</div>';
    try {
      const r = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conditionId: cid, playerHandle: 'visitor' }),
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        result.innerHTML = '<div class="quote-error">runtime ' + r.status + ': ' + esc(errBody.message || errBody.error || 'request failed') + '</div>';
        return;
      }
      const q = await r.json();
      renderQuote(result, cid, q);
    } catch (e) {
      result.innerHTML = '<div class="quote-error">network error: ' + esc(e.message || String(e)) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = 'get signed quote';
    }
  });

  // Find the matching market record so we can decorate the result with
  // human context (question text, polymarket link).
  function findMarket(cid) {
    const lower = (cid || '').toLowerCase();
    for (const m of markets) {
      if ((m.conditionIdWith0x || '').toLowerCase() === lower) return m;
      if (('0x' + (m.conditionId || '')).toLowerCase() === lower) return m;
    }
    return null;
  }

  function renderQuote(el, cid, q) {
    const market = findMarket(cid);
    const haircutPct = q.haircut_bps ? (q.haircut_bps / 100).toFixed(2) + '%' : '—';
    const haircutClass = q.haircut_bps == null
      ? ''
      : q.haircut_bps >= 1800 ? 'is-bad' : q.haircut_bps >= 1300 ? 'is-warn' : 'is-good';
    const principal = q.principal_cap_usdc_6dec
      ? '$' + Number(BigInt(q.principal_cap_usdc_6dec) / 1_000_000n).toLocaleString('en-US')
      : '—';
    const mid = q.mid || '—';
    const wizardLine = q.response_text || '';
    const inf = q.inference;

    let html = '';
    if (market && market.question) {
      html += '<div class="quote-grid"><span class="quote-key">market</span><span class="quote-val" style="line-height:1.35">' + esc(market.question) + '</span></div>';
    }
    html += '<div class="quote-grid">'
      +   '<span class="quote-key">mid</span><span class="quote-val">' + esc(mid) + '</span>'
      +   '<span class="quote-key">haircut</span><span class="quote-val ' + haircutClass + '">' + esc(haircutPct) + ' (' + (q.haircut_bps ?? '—') + ' bps)</span>'
      +   '<span class="quote-key">max loan</span><span class="quote-val">' + esc(principal) + ' USDC</span>'
      + '</div>';
    if (wizardLine) {
      html += '<div class="quote-line">"' + esc(wizardLine) + '"</div>';
    }
    // Receipt row: provider/model + click-to-verify event id, plus a
    // polymarket link for the visitor to verify the underlying market.
    const receiptParts = [];
    if (inf && inf.provider) {
      receiptParts.push('<span class="quote-receipt-pill">' + esc(inf.provider) + ' · ' + esc(inf.model || 'model') + '</span>');
    }
    if (inf && inf.eventId) {
      receiptParts.push(
        '<a class="quote-receipt-link" href="/api/events/' + esc(inf.eventId) + '" target="_blank" rel="noopener">'
        + 'op.inference ' + esc(inf.eventId.slice(0, 8)) + '… ↗</a>',
      );
    }
    if (q.signed_by) {
      receiptParts.push('<span style="color:var(--fg-dim)">signed by ' + esc(q.signed_by.slice(0, 16)) + '…</span>');
    }
    if (market && (market.polymarket_url || market.polymarket_slug)) {
      const url = market.polymarket_url || (POLYMARKET_BASE + market.polymarket_slug);
      receiptParts.push('<a class="quote-receipt-link" href="' + esc(url) + '" target="_blank" rel="noopener">view on polymarket ↗</a>');
    }
    if (receiptParts.length > 0) {
      html += '<div class="quote-receipt">' + receiptParts.join(' ') + '</div>';
    }
    el.innerHTML = html;
  }
}

// ---------- Lender widget (title screen) ----------
// Visitor picks an amount of USDC, presses "deposit to vault". The
// runtime either issues a real LpVault.deposit() tx (when lender-wallet
// env is set on prod) or accumulates a demo balance — either way the
// chest renderer fills in-world. Closes the "no external lender" gap;
// the visitor IS the external lender. Result panel surfaces the tx
// hash on Basescan when a real on-chain deposit happened.
function hookLendWidget() {
  const widget = document.getElementById('lend-widget');
  if (!widget) return;
  const amountEl = document.getElementById('lend-amount');
  const btn = document.getElementById('lend-btn');
  const result = document.getElementById('lend-result');
  if (!amountEl || !btn || !result) return;

  // Visitor handle persists per-browser so successive deposits look
  // like the same lender (random-but-stable).
  let handle = null;
  try { handle = localStorage.getItem('vanta-lender-handle'); } catch (_) {}
  if (!handle) {
    handle = 'visitor-' + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem('vanta-lender-handle', handle); } catch (_) {}
  }

  btn.addEventListener('click', async () => {
    const amountUsd = Number.parseInt(amountEl.value, 10);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      result.removeAttribute('hidden');
      result.innerHTML = '<div class="quote-error">pick an amount</div>';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'depositing…';
    result.removeAttribute('hidden');
    result.innerHTML = '<div class="quote-error" style="color:var(--fg-dim);font-style:italic">submitting deposit…</div>';
    try {
      const r = await fetch('/api/lend', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bot: handle, amount_usd: amountUsd }),
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        result.innerHTML = '<div class="quote-error">runtime ' + r.status + ': ' + esc(errBody.message || errBody.error || 'request failed') + '</div>';
        return;
      }
      const d = await r.json();
      renderLendResult(result, amountUsd, d);
    } catch (e) {
      result.innerHTML = '<div class="quote-error">network error: ' + esc(e.message || String(e)) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = 'deposit to vault';
    }
  });

  function renderLendResult(el, amountUsd, d) {
    const mode = d.mode || 'demo';
    const txHash = d.tx_hash || null;
    const total = d.total ? formatUsdc6(d.total) : '?';
    let html = '<div class="quote-grid">'
      + '<span class="quote-key">handle</span><span class="quote-val">' + esc(handle) + '</span>'
      + '<span class="quote-key">amount</span><span class="quote-val">$' + amountUsd.toLocaleString('en-US') + ' USDC</span>'
      + '<span class="quote-key">mode</span><span class="quote-val ' + (mode === 'real' ? 'is-good' : 'is-warn') + '">'
      +   esc(mode === 'real' ? 'on-chain LpVault.deposit ✓' : 'demo accumulator (lender-wallet env not set)')
      + '</span>'
      + '<span class="quote-key">vault total</span><span class="quote-val">' + esc(total) + ' USDC</span>'
      + '</div>';
    const receiptParts = [];
    if (txHash) {
      receiptParts.push('<a class="quote-receipt-link" href="' + esc(BASESCAN_TX_BASE + txHash) + '" target="_blank" rel="noopener">tx ' + esc(txHash.slice(0, 10)) + '… ↗</a>');
    }
    if (d.real_error) {
      receiptParts.push('<span style="color:var(--gold)">real-deposit attempt: ' + esc(String(d.real_error).slice(0, 80)) + '</span>');
    }
    if (receiptParts.length > 0) {
      html += '<div class="quote-receipt">' + receiptParts.join(' ') + '</div>';
    }
    el.innerHTML = html;
  }
}
