/**
 * Module-scoped pub/sub bridging the demo connector → WalletProvider.
 *
 * RainbowKit's wallet picker invokes a wagmi connector when a user
 * clicks "Demo account". The demo connector lives outside React, so it
 * can't call into context directly. WalletProvider registers its
 * `enterDemo` / `disconnect` callbacks here at mount; the connector
 * fires `triggerDemoConnect()` / `triggerDemoDisconnect()` to flip
 * the synthetic demo state.
 *
 * Single-bridge contract: only one WalletProvider mounts at a time.
 * Re-mount overwrites the previous registration.
 */

interface DemoBridge {
  readonly enterDemo: () => void;
  readonly disconnectDemo: () => void;
}

let bridge: DemoBridge | null = null;

export function setDemoBridge(b: DemoBridge | null): void {
  bridge = b;
}

export function triggerDemoConnect(): void {
  bridge?.enterDemo();
}

export function triggerDemoDisconnect(): void {
  bridge?.disconnectDemo();
}

// Valid 40-char hex (so wagmi's address validation passes when the
// demo connector reports it on `connect()`), but obviously fake when
// rendered in the AccountChip — reads as "dead" repeated.
export const DEMO_ADDRESS =
  "0xDeAddeAdDeAddeAdDeAddeAdDeAddeAdDeAdDeAd" as const;
