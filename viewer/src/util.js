// Shared truncation + URL helpers for launcher.js + console.js.
// Mirrors bridge-plugin/.../HexUtil.kt — keep both in lockstep.

export const BASESCAN_TX_BASE = 'https://sepolia.basescan.org/tx/';
export const BASESCAN_BLOCK_BASE = 'https://sepolia.basescan.org/block/';
export const BASESCAN_ADDR_BASE = 'https://sepolia.basescan.org/address/';
// Polymarket serves YES/NO markets at /market/<market-slug>. Use this
// for direct landings on the bot's specific bet (vs. /event/ which
// shows the parent group). Mirrors polymarketUrl() in bot-positions.ts.
export const POLYMARKET_BASE = 'https://polymarket.com/market/';

export function truncateHex(s, head = 6, tail = 4) {
  if (typeof s !== 'string' || s.length === 0) return '—';
  const stripped = s.startsWith('0x') ? s : '0x' + s;
  if (stripped.length <= head + tail + 3) return stripped;
  return stripped.slice(0, head) + '…' + stripped.slice(-tail);
}

// USDC has 6 decimals. "1000000" → "1.000000"; tolerates string or bigint.
export function formatUsdc6(raw6) {
  let n;
  try {
    n = typeof raw6 === 'bigint' ? raw6 : BigInt(String(raw6 || '0'));
  } catch (_) {
    return '?';
  }
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0');
  return whole.toString() + '.' + frac;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
