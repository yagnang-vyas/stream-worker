import { Link } from "react-router-dom";
import { Badge, Card, EmptyState, Mono } from "./ui";
import { formatAge } from "@/lib/format";
import type { QueueStatsDto } from "@/lib/types";

export function StatsTable({ queues }: { queues: QueueStatsDto[] }) {
  if (queues.length === 0) {
    return (
      <Card>
        <EmptyState title="No queues are registered with this admin API">
          The admin app only lists the queues it was created with (<Mono>create_admin_app(queues=[…])</Mono>).
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Queue statistics (current state)</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-2 font-medium">Queue</th>
            <th scope="col" className="px-3 py-2 text-right font-medium" title="XLEN of the stream: ready + pending">length</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">pending</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">consumers</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">delayed</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">dead</th>
            <th scope="col" className="px-4 py-2 text-right font-medium">oldest pending</th>
          </tr>
        </thead>
        <tbody>
          {queues.map((q) => (
            <tr key={q.name} className="border-b border-border last:border-0">
              <th scope="row" className="px-4 py-2 text-left font-normal">
                <Link className="font-mono text-accent hover:underline" to={`/queues/${encodeURIComponent(q.name)}`}>
                  {q.name}
                </Link>
              </th>
              <td className="px-3 py-2 text-right font-mono">{q.length}</td>
              <td className="px-3 py-2 text-right font-mono">{q.pending}</td>
              <td className="px-3 py-2 text-right font-mono">{q.consumers}</td>
              <td className="px-3 py-2 text-right font-mono">{q.delayed}</td>
              <td className="px-3 py-2 text-right font-mono">
                {q.dead > 0 ? <Badge tone="bad">{q.dead}</Badge> : q.dead}
              </td>
              <td className="px-4 py-2 text-right font-mono">{formatAge(q.oldest_pending_age_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function StatsDisclaimer() {
  return (
    <p className="text-xs text-muted-foreground">
      These numbers describe the queue’s <strong>current state</strong> as reported by <Mono>Queue.stats()</Mono>. They
      are not a job ledger: acknowledged jobs are deleted, so there is no completed-job total, throughput, latency or
      success rate. <Mono>length</Mono> counts ready plus pending entries; retries wait in <Mono>delayed</Mono>.
    </p>
  );
}
