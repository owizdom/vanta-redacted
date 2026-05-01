/**
 * viem wallet/public client pair bound to the derived origination EOA.
 *
 * Created once at boot (in `bootstrap.ts`) and re-used by every
 * service that needs to write to LoanBook. We expose a thin getter so
 * downstream code does not reach into `Bootstrap` directly.
 */

import type { PublicClient, WalletClient } from "viem";

import type { Bootstrap } from "../bootstrap.js";

export interface WalletBundle {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
}

export function getWalletBundle(boot: Bootstrap): WalletBundle {
  return {
    publicClient: boot.publicClient,
    walletClient: boot.walletClient,
  };
}
