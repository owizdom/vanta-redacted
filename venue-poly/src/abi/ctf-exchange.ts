/**
 * Minimal ABI for the Polymarket CTFExchange on Amoy
 * (`0xdFE02Eb6…d99E40`).
 *
 * Scope: only the two read accessors used to cross-check `CTF_ADDRESS`
 * and `USDC_AMOY_ADDRESS` at boot. Trading functions (`matchOrders`,
 * `cancelOrders`, etc.) are intentionally omitted — VANTA's venue
 * binding is a pledge path, not a trading path.
 */

export const CTF_EXCHANGE_ABI = [
  {
    type: "function",
    name: "getCtf",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getCollateral",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export type CtfExchangeAbi = typeof CTF_EXCHANGE_ABI;
