/**
 * Browser-only, deterministic model of the StreamWorker job lifecycle (SPEC.md §5–6).
 * It is a simplified illustration: it never talks to Redis, a worker or the admin API,
 * and everything it produces is labelled simulated.
 */
import { bounds, delayFor, validateBackoff, type BackoffConfig } from "./backoff";
import { nextRandom } from "./rng";

export type JobState = "delayed" | "ready" | "pending" | "acked" | "dead";
/** What the (scripted, never executed) handler does on its nth execution. */
export type Outcome = "success" | "fail" | "timeout" | "crash";

export const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024;
export const MAX_ERROR_MESSAGE_CHARS = 1000;

export interface SimJob {
  id: string; // demo job id, e.g. demo-0001
  task: string;
  payload: string; // compact JSON text
  attempt: number;
  maxAttempts: number;
  enqueuedAt: number;
  idempotencyKey?: string;
  queue: string;
  state: JobState;
  dueAt?: number; // delayed
  deliveries: number; // per stream entry (SPEC decision 3)
  consumer?: string;
  deliveredAt?: number;
  runEndsAt?: number;
  executions: number; // total handler starts across attempts/recoveries
  plan: Outcome[]; // scripted outcome per execution; last entry repeats
  malformed?: boolean;
}

export interface SimDead {
  entryId: string;
  job: SimJob;
  errorType: string;
  errorMessage: string;
  failedAt: number;
}

export interface SimWorker {
  id: string;
  status: "idle" | "busy" | "crashed";
  jobId?: string;
}

export interface SimEvent {
  seq: number;
  t: number; // simulated ms
  jobId?: string;
  from?: JobState | "—";
  to?: JobState;
  title: string;
  detail: string;
}

export interface SideEffect {
  jobId: string;
  execution: number;
  applied: boolean;
}

export interface SimConfig {
  visibilityMs: number;
  handlerMs: number;
  idempotencyTtlMs: number;
  backoff: BackoffConfig;
  registeredTasks: string[];
  /** Handler-level dedupe by job id (an application concern, not a library feature). */
  handlerDedupe: boolean;
}

export interface World {
  now: number;
  seq: number;
  nextJob: number;
  nextEntry: number;
  rng: number;
  config: SimConfig;
  workers: SimWorker[];
  jobs: SimJob[];
  dead: SimDead[];
  idem: Record<string, { jobId: string; expiresAt: number }>;
  sideEffects: SideEffect[];
  events: SimEvent[];
}

export const defaultConfig: SimConfig = {
  visibilityMs: 60_000,
  handlerMs: 2_000,
  idempotencyTtlMs: 24 * 3600_000,
  backoff: { base: 1, cap: 300, jitter: "none" },
  registeredTasks: ["send_email", "process_order", "generate_report"],
  handlerDedupe: false,
};

export function createWorld(config: Partial<SimConfig> = {}, workerCount = 2, seed = 1): World {
  return {
    now: 0,
    seq: 0,
    nextJob: 1,
    nextEntry: 1,
    rng: seed >>> 0,
    config: { ...defaultConfig, registeredTasks: [...defaultConfig.registeredTasks], ...config },
    workers: Array.from({ length: workerCount }, (_, i) => ({ id: `worker-${i + 1}`, status: "idle" })),
    jobs: [],
    dead: [],
    idem: {},
    sideEffects: [],
    events: [],
  };
}

export function validateConfig(c: SimConfig): string[] {
  const errors = validateBackoff(c.backoff);
  if (!(c.handlerMs > 0)) errors.push("handler time must be positive");
  // SPEC decision 4: ConfigError otherwise.
  if (!(c.visibilityMs > c.handlerMs)) errors.push("visibility timeout must be greater than handler time");
  if (!(c.idempotencyTtlMs >= 1)) errors.push("idempotency TTL must be at least 1 ms");
  return errors;
}

// ---- enqueue ---------------------------------------------------------------------------

export interface EnqueueInput {
  task: string;
  payload: string; // raw JSON text typed by the user
  idempotencyKey?: string;
  maxAttempts: number;
  delayMs: number;
  queue: string;
  plan?: Outcome[];
  malformed?: boolean;
}

export type EnqueueValidation = { ok: true; compactPayload: string } | { ok: false; errors: string[] };

/** Mirrors Queue.enqueue argument checks and dumps_payload (compact JSON, size limit). */
export function validateEnqueue(input: EnqueueInput): EnqueueValidation {
  const errors: string[] = [];
  if (!input.task.trim()) errors.push("task name must be non-empty");
  if (!input.queue.trim()) errors.push("queue name must be non-empty");
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) errors.push("max_attempts must be an integer of at least 1");
  if (!Number.isFinite(input.delayMs) || input.delayMs < 0) errors.push("delay must not be negative");
  let compact = "";
  try {
    compact = JSON.stringify(input.payload.trim() === "" ? null : JSON.parse(input.payload));
    if (new TextEncoder().encode(compact).length > DEFAULT_MAX_PAYLOAD_BYTES) {
      errors.push(`payload exceeds the ${DEFAULT_MAX_PAYLOAD_BYTES}-byte limit`);
    }
  } catch {
    errors.push("payload is not valid JSON");
  }
  return errors.length ? { ok: false, errors } : { ok: true, compactPayload: compact };
}

export interface EnqueueResult {
  world: World;
  accepted: boolean;
  suppressed: boolean;
  jobId: string | null;
  errors: string[];
}

function log(w: World, e: Omit<SimEvent, "seq" | "t">): void {
  w.events.push({ seq: ++w.seq, t: w.now, ...e });
}

function clone(w: World): World {
  return structuredClone(w);
}

export function enqueue(world: World, input: EnqueueInput): EnqueueResult {
  const check = validateEnqueue(input);
  if (!check.ok) return { world, accepted: false, suppressed: false, jobId: null, errors: check.errors };
  const w = clone(world);
  const key = input.idempotencyKey?.trim() || undefined;
  if (key) {
    const marker = w.idem[key];
    if (marker && marker.expiresAt > w.now) {
      log(w, {
        jobId: marker.jobId,
        title: "Enqueue suppressed",
        detail: `idempotency key "${key}" exists (TTL left ${Math.ceil((marker.expiresAt - w.now) / 1000)}s); nothing enqueued, original id returned`,
      });
      return { world: w, accepted: false, suppressed: true, jobId: marker.jobId, errors: [] };
    }
  }
  const id = `demo-${String(w.nextJob++).padStart(4, "0")}`;
  const delayed = input.delayMs > 0;
  const job: SimJob = {
    id,
    task: input.task.trim(),
    payload: check.compactPayload,
    attempt: 1,
    maxAttempts: input.maxAttempts,
    enqueuedAt: w.now,
    idempotencyKey: key,
    queue: input.queue.trim(),
    state: delayed ? "delayed" : "ready",
    dueAt: delayed ? w.now + input.delayMs : undefined,
    deliveries: 0,
    executions: 0,
    plan: input.plan?.length ? input.plan : ["success"],
    malformed: input.malformed,
  };
  w.jobs.push(job);
  // The marker is written last, as in the enqueue Lua script.
  if (key) w.idem[key] = { jobId: id, expiresAt: w.now + w.config.idempotencyTtlMs };
  log(w, {
    jobId: id,
    from: "—",
    to: job.state,
    title: delayed ? "Enqueued with delay" : "Enqueued",
    detail: delayed ? `ZADD to delayed, due in ${input.delayMs / 1000}s` : "XADD to the stream (ready)",
  });
  return { world: w, accepted: true, suppressed: false, jobId: id, errors: [] };
}

// ---- discrete-event stepping -----------------------------------------------------------

const outcomeFor = (job: SimJob): Outcome => job.plan[Math.min(job.executions - 1, job.plan.length - 1)];

function toDead(w: World, job: SimJob, errorType: string, message: string): void {
  const from = job.state;
  job.state = "dead";
  job.consumer = undefined;
  w.dead.push({
    entryId: `sim-${w.now}-${w.nextEntry++}`,
    job: structuredClone(job),
    errorType,
    errorMessage: message.slice(0, MAX_ERROR_MESSAGE_CHARS),
    failedAt: w.now,
  });
  log(w, { jobId: job.id, from, to: "dead", title: `Dead-lettered (${errorType})`, detail: message });
}

function freeWorker(w: World): SimWorker | undefined {
  return w.workers.find((x) => x.status === "idle");
}

function start(w: World, job: SimJob, worker: SimWorker): void {
  job.executions += 1;
  job.consumer = worker.id;
  job.runEndsAt = w.now + w.config.handlerMs;
  worker.status = "busy";
  worker.jobId = job.id;
  const applied = !(w.config.handlerDedupe && w.sideEffects.some((s) => s.jobId === job.id && s.applied));
  // The scripted handler performs its side effect before it can crash or fail.
  w.sideEffects.push({ jobId: job.id, execution: job.executions, applied });
}

/** Result of one event: the new world plus a short description (empty when idle). */
export interface StepResult {
  world: World;
  progressed: boolean;
  note: string;
}

interface Candidate {
  at: number;
  run: (w: World) => void;
  note: string;
}

function candidates(w: World): Candidate[] {
  const out: Candidate[] = [];
  const hasFree = !!freeWorker(w);
  for (const job of w.jobs) {
    const id = job.id;
    if (job.state === "delayed" && job.dueAt !== undefined) {
      out.push({ at: job.dueAt, note: `promote ${id}`, run: (x) => promote(x, id) });
    }
    if (job.state === "ready" && hasFree) {
      out.push({ at: w.now, note: `deliver ${id}`, run: (x) => deliver(x, id) });
    }
    if (job.state === "pending") {
      if (job.runEndsAt !== undefined) {
        out.push({ at: job.runEndsAt, note: `finish ${id}`, run: (x) => finish(x, id) });
      } else if (job.deliveredAt !== undefined && hasFree) {
        // Nobody is running it (its consumer died): the recovery loop reclaims it once idle.
        out.push({ at: job.deliveredAt + w.config.visibilityMs, note: `recover ${id}`, run: (x) => recover(x, id) });
      }
    }
  }
  return out;
}

const find = (w: World, id: string): SimJob => w.jobs.find((j) => j.id === id)!;

function promote(w: World, jobId: string): void {
  const j = find(w, jobId);
  if (j.malformed) {
    toDead(w, j, "MalformedJob", "undecodable delayed member moved to the dead stream by the promoter");
    return;
  }
  j.state = "ready";
  j.dueAt = undefined;
  log(w, { jobId, from: "delayed", to: "ready", title: "Promoted", detail: "due: the promote script XADDs to the stream, then ZREMs" });
}

function deliver(w: World, jobId: string): void {
  const job = find(w, jobId);
  const worker = freeWorker(w)!;
  job.state = "pending";
  job.deliveries = 1;
  job.deliveredAt = w.now;
  log(w, { jobId, from: "ready", to: "pending", title: `Delivered to ${worker.id}`, detail: "XREADGROUP: the entry enters the consumer group's pending list" });
  if (!w.config.registeredTasks.includes(job.task)) {
    toDead(w, job, "UnknownTask", `no handler registered for task "${job.task}"`);
  } else if (job.malformed) {
    toDead(w, job, "MalformedJob", "stream entry is missing required fields");
  } else {
    start(w, job, worker);
  }
}

function recover(w: World, jobId: string): void {
  const job = find(w, jobId);
  const worker = freeWorker(w)!;
  job.deliveries += 1; // XAUTOCLAIM increments the delivery count
  job.deliveredAt = w.now;
  log(w, {
    jobId,
    from: "pending",
    to: "pending",
    title: `XAUTOCLAIM by ${worker.id}`,
    detail: `idle ≥ visibility timeout (${w.config.visibilityMs / 1000}s); delivery count is now ${job.deliveries}`,
  });
  if (job.deliveries > job.maxAttempts) {
    toDead(w, job, "MaxDeliveriesExceeded", `delivered ${job.deliveries} times without being acknowledged`);
  } else {
    start(w, job, worker);
  }
}

function finish(w: World, jobId: string): void {
  const job = find(w, jobId);
  const worker = w.workers.find((x) => x.id === job.consumer)!;
  const outcome = outcomeFor(job);
  job.runEndsAt = undefined;
  if (outcome === "crash") {
    worker.status = "crashed";
    log(w, { jobId, title: `${worker.id} crashed`, detail: "process killed before XACK; the entry stays pending (the side effect may already have happened)" });
    return;
  }
  worker.status = "idle";
  worker.jobId = undefined;
  if (outcome === "success") {
    job.state = "acked";
    job.consumer = undefined;
    log(w, { jobId, from: "pending", to: "acked", title: "Acknowledged", detail: "success: XACK + XDEL" });
    return;
  }
  const errorType = outcome === "timeout" ? "TimeoutError" : "RuntimeError";
  const message = outcome === "timeout" ? "handler exceeded handler_timeout" : "scripted handler failure";
  if (job.attempt < job.maxAttempts) {
    const r = nextRandom(w.rng);
    w.rng = r.state;
    const delaySec = delayFor(w.config.backoff, job.attempt, r.value);
    const range = bounds(w.config.backoff, job.attempt);
    const failed = job.attempt;
    job.attempt += 1;
    job.state = "delayed";
    job.dueAt = w.now + Math.round(delaySec * 1000);
    job.deliveries = 0; // a retry is a new stream entry
    job.consumer = undefined;
    log(w, {
      jobId,
      from: "pending",
      to: "delayed",
      title: `Retry scheduled (attempt ${job.attempt}/${job.maxAttempts})`,
      detail: `${errorType} on attempt ${failed}; simulated backoff ${delaySec.toFixed(2)}s (range ${range.min}–${range.max}s)`,
    });
  } else {
    toDead(w, job, errorType, message);
  }
}

/** Runs the next event, advancing simulated time to it if needed. */
export function step(world: World): StepResult {
  const w = clone(world);
  const next = candidates(w).sort((a, b) => a.at - b.at)[0];
  if (!next) return { world, progressed: false, note: "Nothing is scheduled." };
  w.now = Math.max(w.now, next.at);
  next.run(w);
  return { world: w, progressed: true, note: next.note };
}

/** Moves the simulated clock forward by `ms`, running every event that comes due. */
export function advance(world: World, ms: number): World {
  const w = clone(world);
  const target = w.now + Math.max(0, ms);
  for (let guard = 0; guard < 10_000; guard++) {
    const next = candidates(w)
      .filter((c) => c.at <= target)
      .sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    w.now = Math.max(w.now, next.at);
    next.run(w);
  }
  w.now = target;
  return w;
}

/** Runs until nothing is scheduled (or `maxEvents`). */
export function runAll(world: World, maxEvents = 500): World {
  let w = world;
  for (let i = 0; i < maxEvents; i++) {
    const r = step(w);
    if (!r.progressed) break;
    w = r.world;
  }
  return w;
}

// ---- operator actions inside the simulation ---------------------------------------------

export function reviveWorker(world: World, workerId: string): World {
  const w = clone(world);
  const worker = w.workers.find((x) => x.id === workerId);
  if (worker?.status === "crashed") {
    worker.status = "idle";
    worker.jobId = undefined;
    log(w, { title: `${workerId} restarted`, detail: "a new process joins the consumer group" });
  }
  return w;
}

export function crashWorker(world: World, workerId: string): World {
  const w = clone(world);
  const worker = w.workers.find((x) => x.id === workerId);
  if (worker?.status === "busy") {
    worker.status = "crashed";
    const job = w.jobs.find((j) => j.id === worker.jobId);
    if (job) job.runEndsAt = undefined;
    log(w, { jobId: job?.id, title: `${workerId} killed`, detail: "simulated SIGKILL: no XACK, no retry scheduled; the entry stays pending" });
  }
  return w;
}

/** Simulated requeue: attempt resets to 1, job returns to ready (Queue.dead_requeue). */
export function requeueDead(world: World, entryId: string): World {
  const w = clone(world);
  const i = w.dead.findIndex((d) => d.entryId === entryId);
  if (i < 0) return world;
  const rec = w.dead[i];
  const job = find(w, rec.job.id);
  job.attempt = 1;
  job.state = "ready";
  job.deliveries = 0;
  job.consumer = undefined;
  job.dueAt = undefined;
  job.malformed = false; // pretend the entry was repaired; an unknown task stays unknown until registered
  w.dead.splice(i, 1);
  log(w, { jobId: job.id, from: "dead", to: "ready", title: "Requeued", detail: "attempt reset to 1; XADD to the stream, then XDEL from dead" });
  return w;
}

export function purgeDead(world: World, entryId: string): World {
  const w = clone(world);
  const i = w.dead.findIndex((d) => d.entryId === entryId);
  if (i < 0) return world;
  const [rec] = w.dead.splice(i, 1);
  log(w, { jobId: rec.job.id, title: "Purged", detail: "XDEL from the dead stream; the entry is gone for good" });
  return w;
}

export function registerTask(world: World, task: string): World {
  const w = clone(world);
  if (!w.config.registeredTasks.includes(task)) w.config.registeredTasks.push(task);
  return w;
}

/** Simulated operator fix: the scripted handler succeeds from its next execution on. */
export function fixHandler(world: World, jobId: string): World {
  const w = clone(world);
  const job = w.jobs.find((j) => j.id === jobId);
  const rec = w.dead.find((d) => d.job.id === jobId);
  if (job) job.plan = [...job.plan.slice(0, job.executions), "success"];
  if (rec) rec.job.plan = job?.plan ?? rec.job.plan;
  if (job) log(w, { jobId, title: "Handler fixed", detail: "the scripted handler will succeed on its next run (stands in for deploying a fix)" });
  return w;
}
