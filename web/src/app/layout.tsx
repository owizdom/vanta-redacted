import type { Metadata } from "next";

import "@rainbow-me/rainbowkit/styles.css";

import { Providers } from "./_components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "VANTA — Autonomous Risk Engine for Prediction-Market Credit",
  description:
    "Resolution-aware haircut. On-chain gate floor. Continuous reasoning loops with signed event log. Lend against prediction-market positions without trusting a curator.",
  metadataBase: new URL("https://vanta.computer"),
  openGraph: {
    title: "VANTA",
    description:
      "Autonomous risk engine for prediction-market credit. Reasoning above the floor.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://rsms.me/" />
        <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
