import { Copy } from "lucide-react";
import { useState } from "react";
import { Banner, Badge, Button, Card, CardHeader, Field, inputCls, JsonBlock, Mono, SimBadge } from "../ui";
import { createWorld, enqueue, validateEnqueue, type EnqueueInput, type World } from "@/sim/engine";

const EXAMPLES: { label: string; input: EnqueueInput }[] = [
  {
    label: "Send an email",
    input: { task: "send_email", payload: '{"to":"ada@example.com","template":"welcome"}', idempotencyKey: "welcome:ada", maxAttempts: 5, delayMs: 0, queue: "emails" },
  },
  {
    label: "Process an order",
    input: { task: "process_order", payload: '{"order_id":1042,"total_cents":4999}', idempotencyKey: "order:1042", maxAttempts: 3, delayMs: 0, queue: "orders" },
  },
  {
    label: "Generate a report (delayed 30 s)",
    input: { task: "generate_report", payload: '{"report":"weekly","format":"pdf"}', maxAttempts: 2, delayMs: 30_000, queue: "reports" },
  },
];

interface FormState {
  task: string;
  payload: string;
  idempotencyKey: string;
  maxAttempts: string;
  delay: string;
  queue: string;
}

const fromInput = (i: EnqueueInput): FormState => ({
  task: i.task,
  payload: i.payload,
  idempotencyKey: i.idempotencyKey ?? "",
  maxAttempts: String(i.maxAttempts),
  delay: String(i.delayMs / 1000),
  queue: i.queue,
});

function toInput(f: FormState): EnqueueInput {
  return {
    task: f.task,
    payload: f.payload,
    idempotencyKey: f.idempotencyKey,
    maxAttempts: f.maxAttempts.trim() === "" ? NaN : Number(f.maxAttempts),
    delayMs: f.delay.trim() === "" ? 0 : Number(f.delay) * 1000,
    queue: f.queue,
  };
}

export function EnqueueLab() {
  const [form, setForm] = useState<FormState>(fromInput(EXAMPLES[0].input));
  const [world, setWorld] = useState<World>(() => createWorld());
  const [result, setResult] = useState<{ text: string; tone: "ok" | "warn"; id: string | null } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    const input = toInput(form);
    const v = validateEnqueue(input);
    if (!v.ok) {
      setErrors(v.errors);
      setResult(null);
      return;
    }
    setErrors([]);
    const r = enqueue(world, input);
    setWorld(r.world);
    setResult(
      r.suppressed
        ? { tone: "warn", id: r.jobId, text: `Suppressed: idempotency key "${form.idempotencyKey}" already exists, so nothing was enqueued. The original job id is returned.` }
        : { tone: "ok", id: r.jobId, text: input.delayMs > 0 ? "Accepted into the (simulated) delayed set." : "Accepted into the (simulated) ready stream." },
    );
  }

  const copy = () => {
    void navigator.clipboard?.writeText(form.payload).catch(() => undefined);
  };

  return (
    <div className="space-y-4">
      <Banner tone="sim" title="Simulated enqueue">
        <p>Nothing is sent anywhere. Demo job ids start with <Mono>demo-</Mono>, and no job is stored in Redis.</p>
      </Banner>
      <Card>
        <CardHeader title="Job enqueue simulator">
          <SimBadge />
        </CardHeader>
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <Button key={ex.label} size="sm" onClick={() => { setForm(fromInput(ex.input)); setErrors([]); setResult(null); }}>
                Load example: {ex.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Task name" htmlFor="enq-task"><input id="enq-task" className={inputCls} value={form.task} onChange={set("task")} /></Field>
            <Field label="Queue (illustrative)" htmlFor="enq-queue"><input id="enq-queue" className={inputCls} value={form.queue} onChange={set("queue")} /></Field>
            <Field label="Idempotency key (optional)" htmlFor="enq-key" hint="A repeat enqueue with the same key within the TTL (default 24 h) returns the original job id and adds nothing.">
              <input id="enq-key" className={inputCls} value={form.idempotencyKey} onChange={set("idempotencyKey")} />
            </Field>
            <Field label="max_attempts" htmlFor="enq-max" hint="Total tries including the first (library default 5). A failure on the last attempt dead-letters the job.">
              <input id="enq-max" className={inputCls} inputMode="numeric" value={form.maxAttempts} onChange={set("maxAttempts")} />
            </Field>
            <Field label="Initial delay (s)" htmlFor="enq-delay" hint="Job waits in the delayed set until due, then the promoter moves it to the stream.">
              <input id="enq-delay" className={inputCls} inputMode="decimal" value={form.delay} onChange={set("delay")} />
            </Field>
          </div>
          <Field label="JSON payload" htmlFor="enq-payload">
            <textarea id="enq-payload" rows={4} className={`${inputCls} h-auto py-2 font-mono`} value={form.payload} onChange={set("payload")} spellCheck={false} />
          </Field>
          {errors.length > 0 && (
            <Banner tone="error" title="Validation failed">
              <ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </Banner>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={submit}>Simulate enqueue</Button>
            <Button onClick={copy}><Copy className="h-4 w-4" aria-hidden /> Copy payload</Button>
            <Button onClick={() => { setWorld(createWorld()); setResult(null); setErrors([]); }}>Clear simulated jobs</Button>
          </div>
        </div>
      </Card>

      {result && (
        <Banner tone={result.tone === "ok" ? "sim" : "warn"} title={result.id ? `Result for ${result.id} (simulated)` : "Result"}>
          <p>{result.text}</p>
        </Banner>
      )}

      <Card>
        <CardHeader title="Simulated jobs">
          <SimBadge />
        </CardHeader>
        {world.jobs.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No simulated jobs yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {world.jobs.map((j) => (
              <li key={j.id} className="space-y-1 px-4 py-3 text-sm">
                <p>
                  <Mono>{j.id}</Mono> <Badge tone="sim">{j.state}</Badge> task <Mono>{j.task}</Mono> on <Mono>{j.queue}</Mono>
                </p>
                <details>
                  <summary className="cursor-pointer text-xs text-accent">Expand JSON details</summary>
                  <JsonBlock
                    label={`Details of ${j.id}`}
                    text={JSON.stringify(
                      { id: j.id, task: j.task, payload: JSON.parse(j.payload), attempt: j.attempt, max_attempts: j.maxAttempts, idempotency_key: j.idempotencyKey ?? null, delayed_until_ms: j.dueAt ?? null },
                      null,
                      2,
                    )}
                  />
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Banner title="Idempotency is about enqueueing, not execution">
        <p>
          The key only stops duplicate <em>enqueues</em>. A job that was enqueued once can still run more than once
          (crash after a side effect, reclaim after the visibility timeout), so handlers need their own idempotency. See
          the Crash &amp; recovery and Idempotency tabs.
        </p>
      </Banner>
    </div>
  );
}
