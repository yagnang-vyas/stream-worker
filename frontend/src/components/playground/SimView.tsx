import { Badge, Card, CardHeader, Mono, SimBadge } from "../ui";
import type { JobState, SimJob, World } from "@/sim/engine";

export const LANES: { state: JobState; label: string; hint: string }[] = [
  { state: "delayed", label: "Delayed", hint: "sorted set, waiting for due time" },
  { state: "ready", label: "Ready", hint: "in the stream, not yet delivered" },
  { state: "pending", label: "Pending", hint: "delivered, not acknowledged" },
  { state: "acked", label: "Acknowledged", hint: "XACK + XDEL: deleted" },
  { state: "dead", label: "Dead-lettered", hint: "dead stream" },
];

const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function Chip({ job, now }: { job: SimJob; now: number }) {
  return (
    <li className="rounded border border-border bg-background px-2 py-1 text-xs">
      <Mono>{job.id}</Mono> <span className="text-muted-foreground">{job.task}</span>
      <div className="text-muted-foreground">
        attempt {job.attempt}/{job.maxAttempts}
        {job.state === "delayed" && job.dueAt !== undefined && ` · due in ${fmt(Math.max(0, job.dueAt - now))}`}
        {job.state === "pending" && job.consumer && ` · ${job.consumer} · deliveries ${job.deliveries}`}
        {job.executions > 0 && ` · ran ${job.executions}×`}
      </div>
    </li>
  );
}

export function Lanes({ world }: { world: World }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {LANES.map((l) => {
        const jobs = world.jobs.filter((j) => j.state === l.state);
        return (
          <section key={l.state} aria-label={`${l.label} lane`} className="rounded-md border border-border p-2">
            <h3 className="text-xs font-semibold">
              {l.label} <span className="font-normal text-muted-foreground">({jobs.length})</span>
            </h3>
            <p className="mb-2 text-[11px] text-muted-foreground">{l.hint}</p>
            <ul className="space-y-1.5">
              {jobs.map((j) => <Chip key={j.id} job={j} now={world.now} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function WorkerStrip({ world }: { world: World }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Simulated workers">
      {world.workers.map((w) => (
        <li key={w.id}>
          <Badge tone={w.status === "crashed" ? "bad" : w.status === "busy" ? "warn" : "ok"}>
            <Mono>{w.id}</Mono> {w.status}
            {w.jobId && ` · ${w.jobId}`}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export function Timeline({ world }: { world: World }) {
  return (
    <Card>
      <CardHeader title="Event timeline">
        <SimBadge />
      </CardHeader>
      {world.events.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">No events yet. Step or run the simulation.</p>
      ) : (
        <ol className="max-h-80 divide-y divide-border overflow-auto" aria-label="Simulated event timeline">
          {world.events.map((e) => (
            <li key={e.seq} className="grid grid-cols-[4.5rem_1fr] gap-3 px-4 py-2 text-sm">
              <Mono className="pt-0.5 text-muted-foreground">t={fmt(e.t)}</Mono>
              <div>
                <p className="font-medium">
                  {e.title}
                  {e.jobId && <Mono className="ml-2 text-muted-foreground">{e.jobId}</Mono>}
                </p>
                {e.from && e.to && (
                  <p className="text-xs">
                    <Mono>{e.from}</Mono> → <Mono>{e.to}</Mono>
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{e.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
