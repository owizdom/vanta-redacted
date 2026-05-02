import { AppShell } from "./_components/app-shell";
import { LiveStrip } from "./_components/live-strip";
import { MarketsTable } from "./_components/markets-table";

export default function AppPage(): JSX.Element {
  return (
    <AppShell>
      <div className="space-y-10">
        <LiveStrip />
        <MarketsTable />
      </div>
    </AppShell>
  );
}
