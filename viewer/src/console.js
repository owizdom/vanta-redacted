// VANTA console client. Polls /messages every 2s for fresh chat; opens
// an EventSource on /events-stream for the runtime ticker; stores the
// full canonical event payload so each row can expand inline to show
// the signed body + Basescan links + copy-to-clipboard hex fields.
//
// Loaded as an ES module (launcher.html + console.html both add it as
// type="module").

import {
  truncateHex,
  escapeHtml as esc,
  BASESCAN_TX_BASE,
  BASESCAN_BLOCK_BASE,
  POLYMARKET_BASE,
} from '/util.js';
import {
  initVoice,
  voiceCanRender,
  voiceEnabled,
  setVoiceEnabled,
  flushNew as flushVoiceNew,
} from '/voice.js';

// ---------------- Chat poll (unchanged shape) ------------------------
let lastTs = 0;

function fmtTs(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour12: false });
}

async function pollChat() {
  try {
    const r = await fetch('/messages', { cache: 'no-store' });
    const data = await r.json();
    const feed = document.getElementById('feed');
    if (!feed) return;
    if (!data.messages || data.messages.length === 0) return;
    // Voice subsystem (silent no-op until visitor enables it).
    flushVoiceNew(data.messages);
    const newest = data.messages[data.messages.length - 1].ts;
    if (newest === lastTs) return;
    lastTs = newest;
    feed.innerHTML = data.messages.map((m) => {
      const role = m.source === 'system'
        ? 'system'
        : (m.username && (m.username.toLowerCase() === 'wizard'
                          || m.username.toLowerCase() === 'vanta') ? 'wizard' : 'other');
      return '<div class="row">'
        + '<div class="ts">' + fmtTs(m.iso) + '</div>'
        + '<div class="who ' + role + '">' + (role === 'system' ? '· system ·' : esc(m.username)) + '</div>'
        + '<div class="text ' + (role === 'system' ? 'system' : '') + '">' + esc(m.text) + '</div>'
      + '</div>';
    }).join('');
    feed.scrollTop = feed.scrollHeight;
  } catch (e) {
    const status = document.getElementById('status');
    if (status) status.textContent = 'disconnected · ' + e.message;
  }
}

// ---------------- Voice toggle -------------------------------------
async function setupVoiceUI() {
  await initVoice();
  if (!voiceCanRender()) return;
  const btns = Array.from(document.querySelectorAll('.voice-toggle'));
  if (btns.length === 0) return;
  function refresh() {
    const on = voiceEnabled();
    for (const b of btns) {
      b.removeAttribute('hidden');
      b.textContent = on ? '🔊' : '🔇';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = on ? 'mute voice' : 'enable voice';
    }
  }
  for (const b of btns) {
    b.addEventListener('click', () => {
      setVoiceEnabled(!voiceEnabled());
      refresh();
    });
  }
  refresh();
}
setupVoiceUI();

// ---------------- Runtime event ticker (expandable) ------------------
function startEventStream() {
  const events = document.getElementById('events');
  if (!events) return;
  const rows = []; // [{id, type, ts, full}], newest first
  const expanded = new Set();
  const MAX = 40;

  function renderEventList() {
    if (rows.length === 0) {
      events.innerHTML = '<div class="empty" style="padding:18px 12px">waiting for events…</div>';
      return;
    }
    events.innerHTML = rows.map(renderRow).join('');
  }

  function renderRow(r) {
    const isOpen = expanded.has(r.id);
    return ''
      + '<div class="erow' + (isOpen ? ' is-open' : '') + '" data-id="' + r.id + '">'
      +   '<div class="erow-head" data-toggle="' + r.id + '">'
      +     '<span class="etype">' + esc(r.type) + '</span>'
      +     '<span class="ets">' + r.ts + '</span>'
      +     '<span class="echev">' + (isOpen ? '▾' : '▸') + '</span>'
      +   '</div>'
      +   (isOpen ? renderDetail(r.full) : '')
      + '</div>';
  }

  function renderDetail(ev) {
    const body = ev?.body || {};
    const txHash = body.txHash;
    const blockNumber = body.blockNumber;
    const fromAddr = body.fromAddr;
    const toAddr = body.toAddr;
    const amount = body.amount;

    // Section 1: provenance (the signed-event chain, always present).
    const prov = [];
    prov.push(kv('event id', truncateHex('0x' + ev.id, 8, 6), '0x' + ev.id));
    if (typeof ev.timestamp === 'number') {
      prov.push(kv('timestamp', new Date(ev.timestamp * 1000).toISOString()));
    }
    if (ev?.tee?.signingPubKey) {
      prov.push(kv('signer', 'VANTA · ed25…' + ev.tee.signingPubKey.slice(-4),
        ev.tee.signingPubKey));
    }
    if (ev.signature) {
      prov.push(kv('signature', truncateHex('0x' + ev.signature, 8, 6),
        ev.signature));
    }
    if (Array.isArray(ev.parent_ids) && ev.parent_ids.length > 0) {
      prov.push(kv('parents',
        ev.parent_ids.map((p) => truncateHex('0x' + p, 6, 4)).join(' · ')));
    }

    // Section 2: chain (only present for events that touched chain).
    const chain = [];
    if (txHash) {
      chain.push(kvLink('tx hash', truncateHex('0x' + txHash, 8, 6),
        BASESCAN_TX_BASE + '0x' + txHash));
    }
    if (blockNumber !== undefined && blockNumber !== null) {
      chain.push(kvLink('block', '#' + blockNumber,
        BASESCAN_BLOCK_BASE + blockNumber));
    }
    if (fromAddr) chain.push(kv('from', truncateHex(fromAddr, 6, 4), fromAddr));
    if (toAddr) chain.push(kv('to', truncateHex(toAddr, 6, 4), toAddr));
    if (typeof amount === 'string' && /^\d+$/.test(amount)) {
      const usdc = (Number(amount) / 1_000_000).toFixed(6)
        .replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      chain.push(kv('amount', usdc + ' USDC'));
    }

    // Section 3: raw body (collapsed, opt-in for the curious).
    const remainingBody = {};
    const skip = new Set(['txHash', 'blockNumber', 'fromAddr', 'toAddr', 'amount']);
    for (const k of Object.keys(body)) if (!skip.has(k)) remainingBody[k] = body[k];
    const hasRemaining = Object.keys(remainingBody).length > 0;

    // Verify-chain CTA — one click → BFS walk parent_ids back to genesis.
    // Inline result panel rendered into a slot we mount client-side.
    const chainSlotId = 'chain-walk-' + ev.id;
    const verifyCta = ''
      + '<div class="ecard-section">'
      +   '<button class="ecard-verify-btn" data-verify-chain="' + ev.id + '">verify chain ↗</button>'
      +   '<div class="ecard-chain-slot" id="' + chainSlotId + '"></div>'
      + '</div>';

    return ''
      + '<div class="ecard">'
      +   '<div class="ecard-section">'
      +     '<div class="ecard-section-label">PROVENANCE</div>'
      +     '<div class="ecard-grid">' + prov.join('') + '</div>'
      +   '</div>'
      +   (chain.length > 0
        ? '<div class="ecard-section">'
          +   '<div class="ecard-section-label">CHAIN</div>'
          +   '<div class="ecard-grid">' + chain.join('') + '</div>'
          + '</div>'
        : '')
      +   verifyCta
      +   (hasRemaining
        ? '<details class="ecard-raw">'
          +   '<summary>raw body</summary>'
          +   '<pre>' + esc(JSON.stringify(remainingBody, null, 2)) + '</pre>'
          + '</details>'
        : '')
      + '</div>';
  }

  function kv(label, val, copyable) {
    const copyAttr = copyable !== undefined
      ? ' data-copy="' + esc(copyable) + '" title="click to copy"'
      : '';
    const cls = copyable !== undefined ? 'ecard-val ecard-copyable' : 'ecard-val';
    return ''
      + '<div class="ecard-row">'
      +   '<span class="ecard-key">' + esc(label) + '</span>'
      +   '<span class="' + cls + '"' + copyAttr + '>' + esc(val) + '</span>'
      + '</div>';
  }
  function kvLink(label, val, href) {
    return ''
      + '<div class="ecard-row">'
      +   '<span class="ecard-key">' + esc(label) + '</span>'
      +   '<a class="ecard-val ecard-link" href="' + esc(href) + '" target="_blank" rel="noopener">'
      +     esc(val) + ' ↗'
      +   '</a>'
      + '</div>';
  }

  function pushEvent(ev, position) {
    const id = ev.id;
    if (rows.some((r) => r.id === id)) return false;
    const ts = (typeof ev.timestamp === 'number')
      ? new Date(ev.timestamp * 1000).toLocaleTimeString([], { hour12: false })
      : new Date().toLocaleTimeString([], { hour12: false });
    const row = { id, type: ev.type, ts, full: ev };
    if (position === 'head') rows.unshift(row);
    else rows.push(row);
    return true;
  }

  // Live SSE (newest events).
  const mountedAt = Math.floor(Date.now() / 1000);
  const es = new EventSource('/events-stream');
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data);
      if (!e || typeof e.id !== 'string') return;
      if (pushEvent(e, 'head')) {
        while (rows.length > MAX) rows.pop();
        renderEventList();
        // Lozenge — only for fresh events past mountedAt-5s, dedupe by id,
        // capped at 3 per session, only on the console screen.
        try { maybeLozenge(e, mountedAt); } catch (_) { /* never block ingest */ }
      }
    } catch (_) { /* malformed event line; ignore */ }
  };
  es.onerror = () => { /* EventSource auto-retries */ };

  // Backfill history so the rail isn't empty when someone first opens
  // the console after the runtime has been running for a while.
  fetch('/api/events?limit=' + MAX, { cache: 'no-store' }).then((r) => r.json()).then((d) => {
    if (!Array.isArray(d?.events)) return;
    let added = 0;
    for (const e of d.events) {
      if (typeof e?.id !== 'string') continue;
      if (pushEvent(e, 'tail')) added += 1;
    }
    if (added > 0) {
      rows.sort((a, b) => (b.full.timestamp || 0) - (a.full.timestamp || 0));
      while (rows.length > MAX) rows.pop();
      renderEventList();
    }
  }).catch(() => {});

  // Delegated click: copyable value → copy + flash; row head → toggle;
  // "verify chain" button → fetch the chain-walk and inline-render it.
  events.addEventListener('click', (ev) => {
    const verifyBtn = ev.target.closest('[data-verify-chain]');
    if (verifyBtn) {
      ev.stopPropagation();
      const id = verifyBtn.getAttribute('data-verify-chain');
      const slot = document.getElementById('chain-walk-' + id);
      if (!slot) return;
      slot.innerHTML = '<div class="ecard-chain-loading">walking parent_ids…</div>';
      verifyBtn.disabled = true;
      fetch('/api/events/' + id + '/chain', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          verifyBtn.disabled = false;
          if (d && Array.isArray(d.chain) && d.chain.length > 0) {
            const reaches = d.reaches_genesis === true;
            const lines = d.chain.map((c, i) => {
              const arrow = i === 0 ? '◉' : '↑';
              const last = i === d.chain.length - 1 && reaches;
              return '<div class="chain-step' + (last ? ' is-genesis' : '') + '">'
                + '<span class="chain-arrow">' + arrow + '</span>'
                + '<span class="chain-type">' + esc(c.type) + '</span>'
                + '<span class="chain-id">' + esc(c.id.slice(0, 10)) + '…</span>'
                + (last ? '<span class="chain-tag">GENESIS</span>' : '')
                + '</div>';
            }).join('');
            const verdict = reaches
              ? '<div class="chain-verdict is-good">✓ chain reaches constitutional.genesis · depth ' + d.depth + '</div>'
              : '<div class="chain-verdict is-warn">⚠ stopped at depth ' + d.depth + ' — genesis not yet reachable from here</div>';
            slot.innerHTML = verdict + '<div class="chain-walk">' + lines + '</div>';
          } else {
            slot.innerHTML = '<div class="ecard-chain-loading">no chain returned</div>';
          }
        })
        .catch(() => {
          verifyBtn.disabled = false;
          slot.innerHTML = '<div class="ecard-chain-loading">chain walk failed</div>';
        });
      return;
    }
    const copyEl = ev.target.closest('[data-copy]');
    if (copyEl) {
      ev.stopPropagation();
      const text = copyEl.getAttribute('data-copy') || '';
      navigator.clipboard?.writeText(text);
      const original = copyEl.textContent;
      copyEl.classList.add('is-copied');
      copyEl.textContent = 'copied';
      setTimeout(() => {
        copyEl.classList.remove('is-copied');
        copyEl.textContent = original;
      }, 900);
      return;
    }
    const head = ev.target.closest('[data-toggle]');
    if (!head) return;
    const id = head.getAttribute('data-toggle');
    if (!id) return;
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    renderEventList();
  });
}

setInterval(pollChat, 2000);
pollChat();
startEventStream();
hookOwnerBanner();
hookHealthStrip();
hookThinkingPanel();
hookMarketsPanel();
hookAgentsPanel();
hookTicker();

// ---------------- "What just happened" lozenges --------------------
// Slide-in toast over the world iframe when a real on-chain event fires
// (settlement / inflow / origination / liquidation). Teaches the visitor
// that the in-world animation they just saw is a real Base Sepolia tx.
//
// Throttling is aggressive: cap 3 per session, skip backfill events,
// dedupe by event id, only render on the console (body.is-console).
const LOZENGE_TYPES = new Set([
  'loan.settlement',
  'loan.liquidation',
  'loan.origination',
  'treasury.inflow',
]);
const LOZENGE_SHOWN_KEY = 'vanta_lozenges_shown_v1';
const LOZENGE_IDS_KEY = 'vanta_lozenge_ids_v1';
const LOZENGE_CAP = 3;

function maybeLozenge(ev, mountedAtSec) {
  if (!LOZENGE_TYPES.has(ev.type)) return;
  // Suppress on launcher screens that aren't the console — title/mode/
  // about don't have a world iframe to overlay; the lozenge is the
  // bridge between particle effect and on-chain truth.
  const onConsole = document.body.classList.contains('is-console') ||
                    document.body.dataset.standalone === 'console';
  if (!onConsole) return;
  // Skip backfill — mountedAt is set when the event stream first
  // connected; anything older than 5s before that is historical.
  const ts = Number(ev.timestamp || 0);
  if (ts > 0 && ts < mountedAtSec - 5) return;
  // Dedupe by id (covers reconnect storms).
  const seenIds = new Set(JSON.parse(sessionStorage.getItem(LOZENGE_IDS_KEY) || '[]'));
  if (seenIds.has(ev.id)) return;
  seenIds.add(ev.id);
  sessionStorage.setItem(LOZENGE_IDS_KEY, JSON.stringify(Array.from(seenIds).slice(-50)));
  // Cap per session.
  const shown = Number(sessionStorage.getItem(LOZENGE_SHOWN_KEY) || '0');
  if (shown >= LOZENGE_CAP) return;
  sessionStorage.setItem(LOZENGE_SHOWN_KEY, String(shown + 1));
  paintLozenge(ev);
}

function paintLozenge(ev) {
  const stack = document.getElementById('lozenge-stack')
    || createLozengeStack();
  const body = ev.body || {};
  const amount = (typeof body.amount === 'string' && /^\d+$/.test(body.amount))
    ? (Number(body.amount) / 1_000_000).toFixed(6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    : null;
  const txHash = body.txHash;
  const blockNumber = body.blockNumber;
  const fromShort = body.fromAddr ? truncateHex(body.fromAddr, 6, 4) : null;
  const haircut = (typeof body.haircutBps === 'number') ? (body.haircutBps / 100).toFixed(1) : null;

  let msg;
  switch (ev.type) {
    case 'loan.settlement':
      msg = `↳ that bell was a real Base Sepolia settlement${amount ? ' · ' + amount + ' USDC' : ''}${blockNumber ? ' · block #' + blockNumber : ''}`;
      break;
    case 'loan.liquidation':
      msg = `↳ position liquidated${amount ? ' · ' + amount + ' USDC recovered' : ''}`;
      break;
    case 'loan.origination':
      msg = `↳ VANTA just signed a quote${amount ? ' · ' + amount + ' USDC principal' : ''}${haircut ? ' · ' + haircut + '% haircut' : ''}`;
      break;
    case 'treasury.inflow':
      msg = `↳ ${amount || '?'} USDC just hit VANTA's treasury${fromShort ? ' · from ' + fromShort : ''}`;
      break;
    default:
      return;
  }

  const verifyHref = txHash
    ? BASESCAN_TX_BASE + '0x' + txHash
    : null;

  const el = document.createElement('div');
  el.className = 'lozenge';
  el.innerHTML = '<span class="lozenge-msg">' + esc(msg) + '</span>'
    + (verifyHref
      ? ' <a class="lozenge-verify" href="' + esc(verifyHref) + '" target="_blank" rel="noopener">verify ↗</a>'
      : '');
  stack.appendChild(el);

  // Voice — if the visitor enabled it, narrate the same line.
  try { flushVoiceNew([{ ts: Date.now(), iso: new Date().toISOString(), username: 'vanta', text: msg.replace(/^↳\s*/, ''), source: 'chat' }]); } catch (_) {}

  // Auto-dismiss after 6s.
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => { el.remove(); }, 240);
  }, 6000);
}

function createLozengeStack() {
  const stack = document.createElement('div');
  stack.className = 'lozenge-stack';
  stack.id = 'lozenge-stack';
  document.body.appendChild(stack);
  return stack;
}

// ---------------- Owner banner -------------------------------------
// The credibility primitive: TEE EOA ≡ LpVault.owner() ≡ LoanBook.owner().
// One identical address in three places, polled every 30s. Lives on
// every page (launcher.html + console.html both load this module).
//
// Four distinct states drive the visual:
//   loading   — initial, before first fetch returns
//   ok        — all three match (green dot, addresses shown)
//   pending   — chain reads not yet available (skip mode or first poll)
//   mismatch  — addresses populated but disagree (red alarm)
async function hookOwnerBanner() {
  const banner = document.getElementById('owner-banner');
  if (!banner) return;

  async function tick() {
    try {
      const r = await fetch('/api/identity-pin', { cache: 'no-store' });
      if (!r.ok) {
        renderBanner({ state: 'pending', reason: 'runtime unavailable' });
        return;
      }
      const d = await r.json();
      const tee = d.tee_address || '';
      const lp = d.lp_vault_owner || '';
      const lb = d.loan_book_owner || '';

      if (lp === '' || lb === '') {
        // Owner reads not available — usually SKIP_CONTRACT_CHECKS=1
        // or first 15s before the agent-state poller has run a cycle.
        renderBanner({
          state: 'pending',
          tee,
          reason: 'on-chain owner reads pending',
        });
        return;
      }
      if (d.all_match === true) {
        renderBanner({ state: 'ok', tee, lp, lb });
      } else {
        renderBanner({ state: 'mismatch', tee, lp, lb });
      }
    } catch (_) {
      renderBanner({ state: 'pending', reason: 'runtime unreachable' });
    }
  }

  function renderBanner({ state, tee = '', lp = '', lb = '', reason = '' }) {
    banner.setAttribute('data-state', state);
    if (state === 'pending') {
      // Single-line layout: dot + "this enclave 0x… · waiting on chain…"
      // — no em-dashes pretending to be addresses.
      banner.innerHTML =
        '<div class="owner-dot"></div>'
        + '<div class="owner-cells owner-cells-pending">'
        +   '<span class="owner-label">this enclave</span>'
        +   '<span class="owner-addr" title="' + esc(tee) + '">'
        +     (tee ? esc(truncateHex(tee, 6, 4)) : '—') + '</span>'
        +   '<span class="owner-pending-msg">· ' + esc(reason || 'waiting on chain') + '</span>'
        + '</div>'
        + '<a class="owner-verify" href="/identity.html" target="_blank" rel="noopener">details ↗</a>';
      return;
    }
    if (state === 'mismatch') {
      banner.innerHTML =
        '<div class="owner-dot"></div>'
        + '<div class="owner-cells">'
        +   '<span class="owner-label">OWNERSHIP DRIFT</span>'
        +   '<span class="owner-label">enclave</span>'
        +   '<span class="owner-addr" title="' + esc(tee) + '">'
        +     (tee ? esc(truncateHex(tee, 6, 4)) : '—') + '</span>'
        +   '<span class="owner-equiv">≠</span>'
        +   '<span class="owner-label">LpVault.owner()</span>'
        +   '<span class="owner-addr" title="' + esc(lp) + '">' + esc(truncateHex(lp, 6, 4)) + '</span>'
        +   '<span class="owner-equiv">≠</span>'
        +   '<span class="owner-label">LoanBook.owner()</span>'
        +   '<span class="owner-addr" title="' + esc(lb) + '">' + esc(truncateHex(lb, 6, 4)) + '</span>'
        + '</div>'
        + '<a class="owner-verify" href="/identity.html" target="_blank" rel="noopener">details ↗</a>';
      return;
    }
    // state === 'ok'
    banner.innerHTML =
      '<div class="owner-dot"></div>'
      + '<div class="owner-cells">'
      +   '<span class="owner-label">this enclave</span>'
      +   '<span class="owner-addr" title="' + esc(tee) + '">' + esc(truncateHex(tee, 6, 4)) + '</span>'
      +   '<span class="owner-equiv">≡</span>'
      +   '<span class="owner-label">LpVault.owner()</span>'
      +   '<span class="owner-addr" title="' + esc(lp) + '">' + esc(truncateHex(lp, 6, 4)) + '</span>'
      +   '<span class="owner-equiv">≡</span>'
      +   '<span class="owner-label">LoanBook.owner()</span>'
      +   '<span class="owner-addr" title="' + esc(lb) + '">' + esc(truncateHex(lb, 6, 4)) + '</span>'
      + '</div>'
      + '<a class="owner-verify" href="/identity.html" target="_blank" rel="noopener">verify ↗</a>';
  }

  tick();
  setInterval(tick, 30_000);
}

// ---------------- Markets vanta is watching ------------------------
// Polls /api/markets/watched on a 30s cadence (the runtime polls
// Polymarket midpoints every 30s; querying the cache faster than that
// just retrieves the same numbers). Renders question text + live mid +
// link to polymarket.com. Owner-bot is rendered as a small pill.
async function hookMarketsPanel() {
  const root = document.getElementById('markets');
  if (!root) return;

  function pickSideMid(m) {
    // Prefer the side a bot is carrying; for watched-only markets show
    // the YES side. Both come back as decimal strings or null.
    const yes = m.mid && typeof m.mid.yes === 'string' ? m.mid.yes : null;
    const no = m.mid && typeof m.mid.no === 'string' ? m.mid.no : null;
    return yes || no || null;
  }

  function renderMarketCard(m) {
    const q = m.question ? esc(m.question) : 'loading question…';
    const sideMid = pickSideMid(m);
    const midClass = m.stale || sideMid === null ? 'market-mid is-stale' : 'market-mid';
    const midText = sideMid === null ? 'no mid' : 'mid ' + sideMid;
    const url = m.polymarket_url || (m.polymarket_slug ? POLYMARKET_BASE + m.polymarket_slug : null);
    const owner = m.owner_bot
      ? '<span class="market-owner">' + esc(m.owner_bot) + '\'s</span>'
      : '<span class="market-owner" style="background:rgba(110,118,129,0.18);color:var(--fg-dim)">watched</span>';
    return '<div class="market-card">'
      + '<div class="market-q">' + q + '</div>'
      + '<div class="market-meta">'
      +   owner
      +   '<span class="' + midClass + '">' + midText + '</span>'
      +   (url ? '<a class="market-link" href="' + esc(url) + '" target="_blank" rel="noopener">polymarket ↗</a>' : '')
      + '</div>'
      + '</div>';
  }

  async function tick() {
    try {
      const r = await fetch('/api/markets/watched', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const markets = Array.isArray(d.markets) ? d.markets : [];
      if (markets.length === 0) return;
      root.innerHTML = markets.map(renderMarketCard).join('');
    } catch (_) {
      // leave the previous render in place; the runtime is unreachable
    }
  }

  tick();
  setInterval(tick, 30_000);
}

// ---------------- Agents in town -----------------------------------
// Each population bot's persistent Polymarket position. Polls
// /api/bots/positions every 10s. Click-to-expand mirrors the event-card
// pattern in startEventStream. Per-card recent interactions are taken
// from the runtime's town-events ring buffer, filtered to that bot.
async function hookAgentsPanel() {
  const root = document.getElementById('agents');
  if (!root) return;
  const opened = new Set();

  function fmtAgo(ts) {
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60) return sec + 's ago';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    return Math.floor(min / 60) + 'h ago';
  }

  function renderRecent(events) {
    if (!Array.isArray(events) || events.length === 0) {
      return '<div class="agent-recent-line">no interactions yet</div>';
    }
    return events.map((e) => {
      const kind = e.kind ? '<span class="agent-recent-kind">' + esc(e.kind) + '</span>' : '';
      return '<div class="agent-recent-line">' + kind + esc(e.text) + ' <span style="opacity:0.6">· ' + fmtAgo(e.ts) + '</span></div>';
    }).join('');
  }

  function renderAgentCard(p) {
    const isOpen = opened.has(p.name);
    const role = p.role || 'agent';
    const sizeDisplay = p.position && p.position.sizeUsdcDisplay ? p.position.sizeUsdcDisplay : '—';
    const side = p.position && p.position.side ? p.position.side : '—';
    const shortName = p.position && p.position.shortName ? p.position.shortName : '—';
    const mid = p.mid !== null && p.mid !== undefined ? p.mid : null;
    const midText = mid === null ? '<span class="agent-mid is-stale" style="font-style:italic">no mid</span>'
                                  : '<span class="agent-mid">mid ' + esc(mid) + '</span>';
    const question = p.market && p.market.question ? p.market.question : 'loading…';
    const polyUrl = p.polymarketUrl || (p.position && p.position.polymarketSlug ? POLYMARKET_BASE + p.position.polymarketSlug : null);

    return '<div class="agent-card ' + (isOpen ? 'is-open' : '') + '" data-bot="' + esc(p.name) + '">'
      + '<div class="agent-head">'
      +   '<span class="agent-name">' + esc(p.name) + '</span>'
      +   '<span class="role-pill" data-role="' + esc(role) + '">' + esc(role) + '</span>'
      +   '<span class="agent-side">' + esc(sizeDisplay) + ' ' + esc(side) + ' · ' + esc(shortName) + '</span>'
      +   midText
      + '</div>'
      + '<div class="agent-body">'
      +   '<div class="agent-row"><span class="agent-key">market</span><span class="agent-val q">' + esc(question) + '</span></div>'
      +   '<div class="agent-row"><span class="agent-key">position</span><span class="agent-val">' + esc(sizeDisplay) + ' of ' + esc(side) + '</span></div>'
      +   '<div class="agent-row"><span class="agent-key">live mid</span><span class="agent-val">' + (mid === null ? '—' : esc(mid)) + '</span></div>'
      +   (polyUrl ? '<a class="agent-poly" href="' + esc(polyUrl) + '" target="_blank" rel="noopener">view on polymarket ↗</a>' : '')
      +   '<div class="agent-row" style="margin-top:6px"><span class="agent-key">recent</span><div class="agent-recent">' + renderRecent(p.recentInteractions) + '</div></div>'
      + '</div>'
      + '</div>';
  }

  function attachClicks() {
    Array.from(root.querySelectorAll('.agent-card')).forEach((card) => {
      const bot = card.getAttribute('data-bot');
      card.addEventListener('click', () => {
        if (opened.has(bot)) opened.delete(bot);
        else opened.add(bot);
        card.classList.toggle('is-open');
      });
    });
  }

  async function tick() {
    try {
      const r = await fetch('/api/bots/positions', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const positions = Array.isArray(d.positions) ? d.positions : [];
      if (positions.length === 0) return;
      root.innerHTML = positions.map(renderAgentCard).join('');
      attachClicks();
    } catch (_) {
      // keep previous render; runtime unreachable
    }
  }

  tick();
  setInterval(tick, 10_000);
}

// ---------------- Origination ticker (Ship 3) ----------------------
// Bloomberg-style scrolling chyron of bot↔vanta interactions. Reads
// /bridge/town/events every 5s; entries with kind ∈ {QUOTE, PLEDGE,
// DEPOSIT} are rendered with the per-bot shortName (resolved client-
// side from /api/markets/watched, cached at boot) plus the live mid.
// CSS does the marquee animation; JS just keeps the track DOM fresh.
async function hookTicker() {
  const root = document.getElementById('ticker');
  const track = document.getElementById('ticker-track');
  if (!root || !track) return;

  // cid (no 0x prefix or 0x-prefixed) → { shortName, side, mid, owner_bot }
  const ctx = new Map();

  async function refreshCtx() {
    try {
      const r = await fetch('/api/markets/watched', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      for (const m of (d.markets || [])) {
        const cidNoPrefix = (m.conditionId || '').toLowerCase();
        const cidWith0x = (m.conditionIdWith0x || '0x' + cidNoPrefix).toLowerCase();
        const yes = m.mid && m.mid.yes;
        const no = m.mid && m.mid.no;
        const side = m.owner_side || (yes && !no ? 'YES' : (no && !yes ? 'NO' : (yes ? 'YES' : 'NO')));
        const mid = side === 'YES' ? yes : no;
        const shortName = m.short_name || cidNoPrefix.slice(0, 8);
        const entry = { shortName, side, mid, owner: m.owner_bot || null };
        ctx.set(cidNoPrefix, entry);
        ctx.set(cidWith0x, entry);
      }
    } catch (_) { /* keep previous ctx */ }
  }

  // Bot-shortName fallback (Ship 1 fixture). Mirrors runtime/src/services/
  // bot-positions.ts. Used when an event carries `bot` but no `cid`.
  const BOT_SHORT = {
    Alice: { shortName: 'Beshear-2028', side: 'YES' },
    Bob: { shortName: 'USA-WC2026', side: 'NO' },
    Eve: { shortName: 'Curacao-WC2026', side: 'NO' },
    Cynthia: { shortName: 'Buttigieg-2028', side: 'YES' },
    Daniel: { shortName: 'Argentina-WC2026', side: 'YES' },
  };

  const seenTs = new Set();
  const entries = []; // newest at the end, capped at 12

  function abbrev(s) {
    if (!s) return '';
    return s.length > 22 ? s.slice(0, 22) + '…' : s;
  }

  function eventToEntry(e) {
    const bot = e.bot || '';
    const kind = e.kind || null;
    if (!kind) return null; // ticker shows only structured events
    const cid = (e.cid || '').toLowerCase();
    const cidCtx = cid ? ctx.get(cid) : null;
    const botCtx = BOT_SHORT[bot] || null;
    const side = e.side || (cidCtx && cidCtx.side) || (botCtx && botCtx.side) || '';
    const shortName = (cidCtx && cidCtx.shortName) || (botCtx && botCtx.shortName) || '';
    const mid = cidCtx && cidCtx.mid;
    return {
      ts: e.ts,
      bot,
      kind,
      side,
      shortName,
      mid,
      text: e.text || '',
    };
  }

  function renderEntry(e) {
    const sideShort = e.side ? esc(e.side) + ' ' + esc(abbrev(e.shortName)) : esc(abbrev(e.shortName) || e.text);
    const midPart = e.mid ? '<span class="ticker-mid">mid ' + esc(e.mid) + '</span><span class="ticker-sep">·</span>' : '';
    return '<span class="ticker-entry">'
      + '<span class="ticker-bot">' + esc(e.bot) + '</span>'
      + '<span class="ticker-arrow">⟶</span>'
      + '<span class="ticker-vanta">vanta</span>'
      + '<span class="ticker-sep">·</span>'
      + '<span class="ticker-kind" data-kind="' + esc(e.kind) + '">' + esc(e.kind) + '</span>'
      + '<span class="ticker-sep">·</span>'
      + sideShort
      + (midPart ? '<span class="ticker-sep">·</span>' + midPart : '')
      + '</span>';
  }

  function rerender() {
    if (entries.length === 0) {
      root.setAttribute('hidden', '');
      document.body.removeAttribute('data-ticker-on');
      return;
    }
    root.removeAttribute('hidden');
    document.body.setAttribute('data-ticker-on', 'true');
    // Repeat the entries twice so the marquee loop always has content
    // visible (a single short list disappears off-screen during the gap).
    const block = entries.map(renderEntry).join('<span class="ticker-sep">|</span>');
    track.innerHTML = block + '<span class="ticker-sep" style="margin:0 18px">|</span>' + block;
  }

  async function tick() {
    try {
      const r = await fetch('/bridge/town/events', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const evs = Array.isArray(d.events) ? d.events : [];
      let added = false;
      for (const e of evs) {
        if (!e || typeof e.ts !== 'number') continue;
        if (seenTs.has(e.ts)) continue;
        const entry = eventToEntry(e);
        if (!entry) continue;
        seenTs.add(e.ts);
        entries.push(entry);
        added = true;
      }
      if (added) {
        while (entries.length > 12) entries.shift();
        rerender();
      }
    } catch (_) { /* runtime unreachable; keep last paint */ }
  }

  await refreshCtx();
  tick();
  setInterval(refreshCtx, 60_000);
  setInterval(tick, 5_000);
}

// ---------------- Agent thinking · op.inference --------------------
// Polls /api/events?type=op.inference&limit=8 every 6s. Each row shows
// role + provider/model + a one-line excerpt + click-to-verify event id.
// Closes "the agent's thinking is invisible" gap: visitors see the LLM
// is real, attributable, and signed.
async function hookThinkingPanel() {
  const root = document.getElementById('thinking');
  if (!root) return;
  let lastIds = new Set();

  function fmtAgo(unixMs) {
    const d = Math.max(0, Date.now() - unixMs);
    const sec = Math.floor(d / 1000);
    if (sec < 60) return sec + 's ago';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    return Math.floor(min / 60) + 'h ago';
  }

  function renderRow(ev) {
    const body = ev.body || {};
    const role = body.role || 'wizard';
    const provider = body.provider || '?';
    const model = body.model || '?';
    const excerpt = body.response_text_excerpt || '';
    const promptHash = body.request_canonical_hash || '';
    const ago = fmtAgo(ev.timestamp ? ev.timestamp * 1000 : Date.now());
    return '<div class="think-row">'
      + '<div class="think-head">'
      +   '<span class="think-pill">' + esc(role) + '</span>'
      +   '<span class="think-model">' + esc(provider) + ' · ' + esc(model) + '</span>'
      +   '<a class="think-link" href="/api/events/' + esc(ev.id) + '" target="_blank" rel="noopener">' + esc(ev.id.slice(0, 8)) + '… ↗</a>'
      + '</div>'
      + (excerpt ? '<div class="think-text">"' + esc(excerpt.slice(0, 220)) + '"</div>' : '')
      + '<div class="think-meta">prompt-hash ' + esc(promptHash.slice(0, 12)) + '… · ' + esc(ago) + '</div>'
      + '</div>';
  }

  async function tick() {
    try {
      const r = await fetch('/api/events?type=op.inference&limit=8', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const events = Array.isArray(d.events) ? d.events : [];
      if (events.length === 0) return;
      // Newest first — events route returns descending so just keep order.
      const ids = new Set(events.map((e) => e.id));
      // Skip render if nothing changed.
      let changed = events.length !== lastIds.size;
      if (!changed) {
        for (const id of ids) { if (!lastIds.has(id)) { changed = true; break; } }
      }
      if (!changed) return;
      lastIds = ids;
      root.innerHTML = events.map(renderRow).join('');
    } catch (_) { /* keep last paint */ }
  }

  tick();
  setInterval(tick, 6_000);
}

// ---------------- Health chips strip --------------------------------
// Polls /api/health/components every 10s and paints status onto the
// four chips at the top of the rail. Tooltip on each chip shows the
// last-fresh timestamp and any error detail. Closes the "no degraded
// story" gap — when polymarket goes down, the chip turns amber and the
// tooltip says why.
async function hookHealthStrip() {
  const strip = document.getElementById('health-strip');
  if (!strip) return;
  const chips = Array.from(strip.querySelectorAll('.health-chip'));

  function fmtAge(ms) {
    if (ms === null || ms === undefined) return 'never';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    return Math.floor(sec / 3600) + 'h';
  }

  async function tick() {
    try {
      const r = await fetch('/api/health/components', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      for (const chip of chips) {
        const comp = chip.getAttribute('data-comp');
        const data = d[comp];
        if (!data) continue;
        chip.setAttribute('data-status', data.status || 'unknown');
        let title = comp + ' · ' + (data.status || 'unknown');
        if (data.age_ms !== undefined && data.age_ms !== null) {
          title += ' · last fresh ' + fmtAge(data.age_ms) + ' ago';
        }
        if (data.detail) title += ' · ' + data.detail;
        if (data.provider) title += ' · provider=' + data.provider;
        if (data.tip_event_id) title += ' · tip=' + data.tip_event_id.slice(0, 8) + '…';
        if (data.approx_count !== undefined) title += ' · ~' + data.approx_count + ' events';
        if (data.stale_count !== undefined && data.total_count !== undefined) {
          title += ' · ' + (data.total_count - data.stale_count) + '/' + data.total_count + ' fresh';
        }
        chip.setAttribute('title', title);
      }
    } catch (_) {
      // network down — flip everything to unknown
      for (const chip of chips) {
        chip.setAttribute('data-status', 'unknown');
        chip.setAttribute('title', chip.getAttribute('data-comp') + ' · runtime unreachable');
      }
    }
  }

  tick();
  setInterval(tick, 10_000);
}
