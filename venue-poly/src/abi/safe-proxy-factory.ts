/**
 * Minimal ABI for the Gnosis SafeProxyFactory v1.3.0 on Amoy
 * (`0xa6B71E26…4b6a896AB2`).
 *
 * Scope: only what the proxy-address predictor needs at read time
 * (`proxyCreationCode`) plus the single mutator used by the fresh-
 * proxy fixture path (`createProxyWithNonce`).
 */

export const SAFE_PROXY_FACTORY_ABI = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "function",
    name: "proxyCreationCode",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

export type SafeProxyFactoryAbi = typeof SAFE_PROXY_FACTORY_ABI;
