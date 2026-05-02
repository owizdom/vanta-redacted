import { AgentBand } from "./_components/agent-band";
import { AppShell } from "./_components/app-shell";
import { MarketsTable } from "./_components/markets-table";

export default function AppPage(): JSX.Element {
  return (
    <AppShell>
      <div className="space-y-8">
        <AgentBand />
        <MarketsTable />
      </div>
    </AppShell>
  );
}
