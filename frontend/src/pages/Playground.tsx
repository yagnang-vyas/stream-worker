import { useState } from "react";
import { BackoffLab } from "@/components/playground/BackoffLab";
import { ConcurrencyLab } from "@/components/playground/ConcurrencyLab";
import { EnqueueLab } from "@/components/playground/EnqueueLab";
import { IdempotencyLab } from "@/components/playground/IdempotencyLab";
import { SimConsole } from "@/components/playground/SimConsole";
import { Banner, Button, Mono } from "@/components/ui";
import { cn } from "@/lib/cn";
import { SCENARIOS } from "@/sim/scenarios";

const pick = (...ids: string[]) => SCENARIOS.filter((s) => ids.includes(s.id));

const TABS = [
  { id: "enqueue", label: "Enqueue" },
  { id: "lifecycle", label: "Lifecycle" },
  { id: "backoff", label: "Retry & backoff" },
  { id: "crash", label: "Crash & recovery" },
  { id: "idempotency", label: "Idempotency" },
  { id: "dead", label: "Dead letter" },
  { id: "concurrency", label: "Concurrency" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function Playground() {
  const [tab, setTab] = useState<TabId>("enqueue");
  // Bumping the epoch remounts every lab, discarding all simulated state.
  const [epoch, setEpoch] = useState(0);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Playground</h1>
        <Button size="sm" onClick={() => setEpoch((e) => e + 1)}>Reset everything</Button>
      </div>
      <Banner tone="sim" title="Simulation Mode: runs entirely in your browser">
        <p>
          No Redis, worker or credentials are used and no requests are made. Resetting here never affects the real queues
          shown in the dashboard. Demo job ids look like <Mono>demo-0001</Mono>; user code is never executed.
        </p>
      </Banner>
      <div role="tablist" aria-label="Playground labs" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="lab-panel"
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab === t.id ? "border-accent font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="lab-panel" aria-labelledby={`tab-${tab}`} key={`${tab}-${epoch}`}>
        {tab === "enqueue" && <EnqueueLab />}
        {tab === "lifecycle" && <SimConsole scenarios={pick("success", "retry-then-success", "exhausted", "delayed", "unknown", "malformed")} />}
        {tab === "backoff" && <BackoffLab />}
        {tab === "crash" && <SimConsole scenarios={pick("crash", "recovered", "poison")} recovery />}
        {tab === "idempotency" && <IdempotencyLab />}
        {tab === "dead" && <SimConsole scenarios={pick("exhausted", "unknown", "malformed")} deadLetter />}
        {tab === "concurrency" && <ConcurrencyLab />}
      </div>
    </>
  );
}
