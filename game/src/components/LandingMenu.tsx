import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { AboutModal } from "./AboutModal";
import { PixelButton } from "./PixelButton";

export function LandingMenu(): JSX.Element {
  const navigate = useNavigate();
  const [showAbout, setShowAbout] = useState(false);

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-end pb-[8vh]">
        {/* bloom under the menu */}
        <div className="bloom-violet pointer-events-none absolute inset-0" />

        <div className="pointer-events-auto flex flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-2 mb-6">
            <h1 className="font-display text-7xl font-bold text-chalk-50 tracking-tight">
              VANTA
            </h1>
            <p className="font-mono text-xs uppercase tracking-[0.32em] text-chalk-400">
              verifiable ai lenders · prediction-market collateral
            </p>
          </div>

          <div className="flex flex-col items-stretch gap-3 min-w-[260px]">
            <PixelButton
              variant="primary"
              size="lg"
              onClick={() => navigate("/world")}
            >
              ▶ play
            </PixelButton>

            <ConnectButton.Custom>
              {({ account, chain, openConnectModal, openAccountModal, mounted }) => {
                const ready = mounted;
                const connected = ready && account && chain;
                return (
                  <PixelButton
                    onClick={connected ? openAccountModal : openConnectModal}
                  >
                    {connected
                      ? `🔓 ${account.displayName}`
                      : "connect wallet"}
                  </PixelButton>
                );
              }}
            </ConnectButton.Custom>

            <PixelButton onClick={() => setShowAbout(true)}>
              about
            </PixelButton>
          </div>

          <div className="mt-6 font-mono text-[10px] uppercase tracking-[0.32em] text-chalk-500">
            v3.0 · base sepolia
          </div>
        </div>
      </div>

      <AboutModal open={showAbout} onClose={() => setShowAbout(false)} />
    </>
  );
}
