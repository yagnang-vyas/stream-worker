import { useMemo, useState } from "react";
import { Banner, Card, CardHeader, Field, inputCls, Mono, SimBadge } from "../ui";
import { simulateConcurrency, type ConcJob } from "@/sim/concurrency";

const JOBS: ConcJob[] = [
  { id: "A", durationMs: 4000 },
  { id: "B", durationMs: 1000 },
  { id: "C", durationMs: 3000, failsOnce: true },
  { id: "D", durationMs: 1000 },
  { id: "E", durationMs: 2000 },
  { id: "F", durationMs: 1000 },
];
const COLORS = ["bg-accent/70", "bg-ok/70", "bg-warn/70", "bg-sim/70"];

export function ConcurrencyLab() {
  const [workers, setWorkers] = useState("1");
  const w = Number(workers);
  const valid = Number.isInteger(w) && w >= 1 && w <= 4;
  const r = useMemo(() => (valid ? simulateConcurrency(JOBS, w, 1000) : null), [valid, w]);

  return (
    <div className="space-y-4">
      <Banner tone="sim" title="Illustration only">
        <p>Fixed, made-up job durations. This shows ordering, not throughput; it is not a benchmark of StreamWorker.</p>
      </Banner>
      <Card>
        <CardHeader title="Concurrency and ordering"><SimBadge /></CardHeader>
        <div className="space-y-4 p-4">
          <Field label="Workers / concurrency (1–4)" htmlFor="conc-n">
            <input id="conc-n" className={`${inputCls} w-32`} value={workers} onChange={(e) => setWorkers(e.target.value)} />
          </Field>
          {!valid && <Banner tone="error" title="Enter a whole number from 1 to 4" />}
          {r && (
            <>
              <div className="space-y-1.5" aria-label="Worker timeline">
                {Array.from({ length: w }, (_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Mono className="w-16 shrink-0">worker-{i + 1}</Mono>
                    <div className="relative h-8 grow rounded bg-muted">
                      {r.segments.filter((s) => s.worker === i).map((s) => (
                        <div
                          key={`${s.jobId}-${s.attempt}`}
                          title={`${s.jobId} attempt ${s.attempt} ${s.ok ? "ok" : "failed"}`}
                          className={`absolute top-0.5 flex h-7 items-center justify-center overflow-hidden rounded text-[11px] ${s.ok ? COLORS[i % 4] : "bg-bad/60"}`}
                          style={{ left: `${(s.start / r.makespanMs) * 100}%`, width: `${((s.end - s.start) / r.makespanMs) * 100}%` }}
                        >
                          {s.jobId}{s.attempt > 1 ? "′" : ""}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-sm">
                Submitted order: <Mono>{JOBS.map((j) => j.id).join(" → ")}</Mono>
                <br />
                Completion order: <Mono data-testid="completion-order">{r.completionOrder.join(" → ")}</Mono>
              </p>
              <p className="text-sm text-muted-foreground">
                Job C fails once (red) and is retried (C′) after a 1 s backoff, so it re-enters <em>behind</em> newer jobs.
                With more than one worker, jobs finish out of submission order. StreamWorker makes no ordering guarantee.
              </p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
