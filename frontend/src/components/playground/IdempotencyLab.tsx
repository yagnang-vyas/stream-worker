import { useState } from "react";
import { Timeline } from "./SimView";
import { Banner, Badge, Button, Card, CardHeader, Field, inputCls, Mono, SimBadge } from "../ui";
import { advance, createWorld, enqueue, runAll, type World } from "@/sim/engine";

interface Attempt {
  n: number;
  key: string;
  verdict: "accepted" | "suppressed";
  jobId: string;
}

export function IdempotencyLab() {
  const [ttlSec, setTtlSec] = useState("60");
  const ttl = Number(ttlSec);
  const mk = () => createWorld({ idempotencyTtlMs: (Number.isFinite(ttl) && ttl > 0 ? ttl : 60) * 1000 });
  const [world, setWorld] = useState<World>(mk);
  const [key, setKey] = useState("order:1042");
  const [crashFirst, setCrashFirst] = useState(false);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const ttlOk = Number.isFinite(ttl) && ttl > 0;

  function submit() {
    const r = enqueue(world, {
      task: "process_order",
      payload: '{"order_id":1042}',
      idempotencyKey: key,
      maxAttempts: 3,
      delayMs: 0,
      queue: "orders",
      plan: crashFirst ? ["crash", "success"] : ["success"],
    });
    if (!r.jobId) return;
    setWorld(r.world);
    setAttempts((a) => [...a, { n: a.length + 1, key, verdict: r.suppressed ? "suppressed" : "accepted", jobId: r.jobId! }]);
  }

  const reset = () => { setWorld(mk()); setAttempts([]); };
  const execs = world.jobs.map((j) => ({ id: j.id, n: j.executions }));

  return (
    <div className="space-y-4">
      <Banner tone="sim" title="Simulated idempotency">
        <p>Markers live in a simulated clock. Real markers are Redis keys <Mono>sw:&#123;queue&#125;:idem:&#123;key&#125;</Mono> with a TTL.</p>
      </Banner>
      <Card>
        <CardHeader title="Enqueue idempotency"><SimBadge /></CardHeader>
        <div className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Idempotency key" htmlFor="idem-key"><input id="idem-key" className={inputCls} value={key} onChange={(e) => setKey(e.target.value)} /></Field>
            <Field label="Idempotency TTL (s)" htmlFor="idem-ttl" hint="Library default is 24 h. Changing it resets the lab.">
              <input
                id="idem-ttl"
                className={inputCls}
                value={ttlSec}
                onChange={(e) => setTtlSec(e.target.value)}
                onBlur={reset}
              />
            </Field>
          </div>
          {!ttlOk && <Banner tone="error" title="TTL must be a positive number of seconds" />}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={crashFirst} onChange={(e) => setCrashFirst(e.target.checked)} />
            The first handler run crashes after its side effect (new jobs only)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={world.config.handlerDedupe}
              onChange={(e) => setWorld((w) => ({ ...w, config: { ...w.config, handlerDedupe: e.target.checked } }))}
            />
            Handler-level idempotency (application code checks the job id)
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!ttlOk || !key.trim()} onClick={submit}>Enqueue with this key</Button>
            <Button onClick={() => setWorld((w) => advance(w, 10_000))}>+10s</Button>
            <Button disabled={!ttlOk} onClick={() => setWorld((w) => advance(w, (ttl + 1) * 1000))}>Advance past TTL</Button>
            <Button onClick={() => setWorld((w) => runAll(w))}>Run workers</Button>
            <Button onClick={reset}>Reset</Button>
          </div>
          <p className="text-xs text-muted-foreground">Simulated clock: <Mono>t={(world.now / 1000).toFixed(0)}s</Mono></p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Enqueue attempts"><SimBadge /></CardHeader>
        {attempts.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Enqueue the same key twice, then advance past the TTL and enqueue again.</p>
        ) : (
          <ul className="divide-y divide-border" aria-label="Enqueue attempts">
            {attempts.map((a) => (
              <li key={a.n} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                <span>#{a.n}</span> <Mono>{a.key}</Mono>
                <Badge tone={a.verdict === "accepted" ? "ok" : "warn"}>{a.verdict === "accepted" ? "first enqueue accepted" : "duplicate suppressed"}</Badge>
                <span className="text-muted-foreground">→ job <Mono>{a.jobId}</Mono></span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Handler executions"><SimBadge /></CardHeader>
        <div className="space-y-2 p-4 text-sm">
          {execs.length === 0 ? (
            <p className="text-muted-foreground">No jobs yet.</p>
          ) : (
            <ul aria-label="Handler executions">
              {execs.map((e) => (
                <li key={e.id}>
                  <Mono>{e.id}</Mono> handler ran {e.n}×
                  {world.sideEffects.filter((s) => s.jobId === e.id && s.applied).length > 1 && (
                    <Badge tone="warn" className="ml-2">side effect applied more than once</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground">
            Enqueue idempotency prevents duplicate <em>jobs</em>. It does not make execution exactly-once: after a crash
            the same job is delivered again. A stable job id lets a handler deduplicate its own side effects (for example
            as an idempotency key on a payment call), but that is application code, shown here as a toggle.
          </p>
        </div>
      </Card>
      <Timeline world={world} />
    </div>
  );
}
