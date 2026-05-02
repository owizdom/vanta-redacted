import { Suspense } from "react";

import { AppShell } from "../../_components/app-shell";
import { TradeView } from "../../_components/trade/trade-view";

export default async function TradePage({
  params,
}: {
  readonly params: Promise<{ market: string }>;
}): Promise<JSX.Element> {
  const { market } = await params;
  return (
    <AppShell>
      <Suspense fallback={null}>
        <TradeView marketParam={market} />
      </Suspense>
    </AppShell>
  );
}
