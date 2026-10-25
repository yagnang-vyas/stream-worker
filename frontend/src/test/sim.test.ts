import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bounds, ceiling, retrySchedule, validateBackoff, type Jitter } from "@/sim/backoff";
import { simulateConcurrency } from "@/sim/concurrency";
import {
  advance,
  createWorld,
  enqueue,
  fixHandler,
  purgeDead,
  requeueDead,
  reviveWorker,
  runAll,
  step,
  validateConfig,
  validateEnqueue,
  type EnqueueInput,
} from "@/sim/engine";
import { SCENARIOS, loadScenario } from "@/sim/scenarios";

const scenario = (id: string) => loadScenario(SCENARIOS.find((s) => s.id === id)!);
const base: EnqueueInput = { task: "send_email", payload: "{}", maxAttempts: 3, delayMs: 0, queue: "q" };

describe("backoff parity with streamworker.ExponentialBackoff", () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, "../../fixtures/backoff.json"), "utf8")) as {
    base: number; cap: number; jitter: Jitter; attempt: number; ceiling: number; min: number; max: number;
  }[];

  it("matches every Python-generated ceiling and jitter bound", () => {
    expect(fixture.length).toBeGreaterThan(200);
    for (const c of fixture) {
      const cfg = { base: c.base, cap: c.cap, jitter: c.jitter };
      expect(ceiling(cfg, c.attempt)).toBe(c.ceiling);
      expect(bounds(cfg, c.attempt)).toEqual({ min: c.min, max: c.max });
    }
  });

  it("keeps simulated samples inside the bounds and is deterministic per seed", () => {
    for (const jitter of ["full", "equal", "none"] as const) {
      const cfg = { base: 2, cap: 100, jitter };
      const a = retrySchedule(cfg, 10, 5);
      expect(a).toEqual(retrySchedule(cfg, 10, 5));
      expect(a).toHaveLength(9); // the last attempt is dead-lettered, not retried
      for (const r of a) {
        expect(r.delay).toBeGreaterThanOrEqual(r.min);
        expect(r.delay).toBeLessThanOrEqual(r.max);
      }
    }
  });

  it("rejects invalid configuration like ConfigError", () => {
    expect(validateBackoff({ base: 0, cap: 1, jitter: "none" })).not.toEqual([]);
    expect(validateBackoff({ base: 1, cap: -1, jitter: "none" })).not.toEqual([]);
    expect(validateBackoff({ base: 1, cap: 1, jitter: "wild" as Jitter })).not.toEqual([]);
  });
});

describe("enqueue validation", () => {
  it("rejects bad JSON, empty task and bad max_attempts / delay", () => {
    const bad = validateEnqueue({ ...base, task: " ", payload: "{nope", maxAttempts: 0, delayMs: -1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveLength(4);
  });
  it("compacts valid JSON", () => {
    const v = validateEnqueue({ ...base, payload: '{ "a": 1 }' });
    expect(v).toEqual({ ok: true, compactPayload: '{"a":1}' });
  });
  it("does not change the world when invalid", () => {
    const w = createWorld();
    const r = enqueue(w, { ...base, payload: "{" });
    expect(r.accepted).toBe(false);
    expect(r.world).toBe(w);
  });
});

describe("enqueue idempotency", () => {
  it("suppresses duplicates within the TTL and accepts again after it", () => {
    let w = createWorld({ idempotencyTtlMs: 60_000 });
    const first = enqueue(w, { ...base, idempotencyKey: "k" });
    expect(first.accepted).toBe(true);
    expect(first.jobId).toMatch(/^demo-/);
    w = first.world;
    const dup = enqueue(w, { ...base, idempotencyKey: "k" });
    expect(dup.suppressed).toBe(true);
    expect(dup.jobId).toBe(first.jobId);
    expect(dup.world.jobs).toHaveLength(1);
    w = advance(dup.world, 61_000);
    const again = enqueue(w, { ...base, idempotencyKey: "k" });
    expect(again.accepted).toBe(true);
    expect(again.jobId).not.toBe(first.jobId);
  });

  it("does not make execution exactly-once: a crash re-runs the handler for the same job", () => {
    let w = createWorld();
    w = enqueue(w, { ...base, task: "send_email", idempotencyKey: "k", plan: ["crash", "success"] }).world;
    w = runAll(w);
    expect(w.jobs[0].executions).toBe(2);
    expect(w.sideEffects.filter((s) => s.applied)).toHaveLength(2);
  });

  it("handler-level dedupe skips the second side effect", () => {
    let w = createWorld({ handlerDedupe: true });
    w = enqueue(w, { ...base, plan: ["crash", "success"] }).world;
    w = runAll(w);
    expect(w.jobs[0].executions).toBe(2);
    expect(w.sideEffects.filter((s) => s.applied)).toHaveLength(1);
  });
});

describe("lifecycle scenarios", () => {
  it("success on the first attempt", () => {
    const w = runAll(scenario("success"));
    expect(w.jobs[0].state).toBe("acked");
    expect(w.jobs[0].executions).toBe(1);
  });

  it("fails then succeeds on attempt 3 after two backoff retries", () => {
    const w = runAll(scenario("retry-then-success"));
    expect(w.jobs[0].state).toBe("acked");
    expect(w.jobs[0].attempt).toBe(3);
    expect(w.events.filter((e) => e.title.startsWith("Retry scheduled"))).toHaveLength(2);
    expect(w.now).toBeGreaterThanOrEqual(3000); // backoff 1s then 2s (jitter none) on top of run time
  });

  it("exhausts the retry budget and lands in the dead stream", () => {
    const w = runAll(scenario("exhausted"));
    expect(w.jobs[0].state).toBe("dead");
    expect(w.dead).toHaveLength(1);
    expect(w.dead[0]).toMatchObject({ errorType: "RuntimeError" });
    expect(w.dead[0].job.attempt).toBe(3);
  });

  it("a delayed job waits, then is promoted", () => {
    const w0 = scenario("delayed");
    expect(w0.jobs[0].state).toBe("delayed");
    const early = advance(w0, 29_000);
    expect(early.jobs[0].state).toBe("delayed");
    const late = advance(w0, 30_000);
    expect(["ready", "pending", "acked"]).toContain(late.jobs[0].state);
    expect(late.events.some((e) => e.title === "Promoted")).toBe(true);
  });

  it("step advances time to the next event and reports idle", () => {
    const w0 = scenario("delayed");
    const r = step(w0);
    expect(r.progressed).toBe(true);
    expect(r.world.now).toBe(30_000);
    expect(step(createWorld()).progressed).toBe(false);
  });

  it("unknown task is dead-lettered immediately as UnknownTask", () => {
    const w = runAll(scenario("unknown"));
    expect(w.dead[0].errorType).toBe("UnknownTask");
    expect(w.jobs[0].executions).toBe(0);
  });

  it("malformed entry is dead-lettered as MalformedJob", () => {
    const w = runAll(scenario("malformed"));
    expect(w.dead[0].errorType).toBe("MalformedJob");
  });
});

describe("worker crash and recovery", () => {
  it("with no surviving worker the entry stays pending until one is restarted", () => {
    let w = runAll(scenario("crash"));
    expect(w.workers[0].status).toBe("crashed");
    expect(w.jobs[0].state).toBe("pending");
    w = reviveWorker(w, "worker-1");
    w = runAll(w);
    expect(w.jobs[0].state).toBe("acked");
    expect(w.now).toBeGreaterThanOrEqual(w.config.visibilityMs);
  });

  it("another worker claims the stalled entry only after the visibility timeout", () => {
    const w0 = scenario("recovered");
    const early = advance(w0, 30_000);
    expect(early.jobs[0].state).toBe("pending");
    expect(early.events.some((e) => e.title.startsWith("XAUTOCLAIM"))).toBe(false);
    const w = advance(w0, 62_000);
    expect(w.events.some((e) => e.title.startsWith("XAUTOCLAIM by worker-2"))).toBe(true);
    expect(runAll(w).jobs[0].state).toBe("acked");
    expect(runAll(w).jobs[0].executions).toBe(2);
  });

  it("a shorter visibility timeout recovers sooner", () => {
    const w0 = scenario("recovered");
    w0.config.visibilityMs = 10_000;
    expect(advance(w0, 13_000).events.some((e) => e.title.startsWith("XAUTOCLAIM"))).toBe(true);
  });

  it("dead-letters as poison when deliveries exceed max_attempts, without running", () => {
    const w = runAll(scenario("poison"));
    expect(w.dead[0].errorType).toBe("MaxDeliveriesExceeded");
    expect(w.jobs[0].executions).toBe(1);
  });

  it("requires visibility timeout > handler time like Worker's ConfigError", () => {
    const w = createWorld({ visibilityMs: 1000, handlerMs: 2000 });
    expect(validateConfig(w.config)).toContain("visibility timeout must be greater than handler time");
  });
});

describe("dead-letter requeue and purge", () => {
  it("requeue resets attempt to 1; a fix makes the next run succeed", () => {
    let w = runAll(scenario("exhausted"));
    const entry = w.dead[0].entryId;
    w = requeueDead(w, entry);
    expect(w.dead).toHaveLength(0);
    expect(w.jobs[0]).toMatchObject({ state: "ready", attempt: 1 });
    // still failing: dead again
    const again = runAll(w);
    expect(again.dead).toHaveLength(1);
    // fixed: succeeds
    let fixed = requeueDead(again, again.dead[0].entryId);
    fixed = fixHandler(fixed, fixed.jobs[0].id);
    expect(runAll(fixed).jobs[0].state).toBe("acked");
  });

  it("purge removes the entry and nothing else", () => {
    const w = runAll(scenario("exhausted"));
    const p = purgeDead(w, w.dead[0].entryId);
    expect(p.dead).toHaveLength(0);
    expect(p.jobs[0].state).toBe("dead");
  });

  it("an unknown task stays dead until its handler is registered", async () => {
    const { registerTask } = await import("@/sim/engine");
    let w = runAll(scenario("unknown"));
    w = requeueDead(w, w.dead[0].entryId);
    w = runAll(w);
    expect(w.dead).toHaveLength(1);
    w = requeueDead(w, w.dead[0].entryId);
    w = runAll(registerTask(w, "send_fax"));
    expect(w.jobs[0].state).toBe("acked");
  });
});

describe("reset behaviour", () => {
  it("a reloaded scenario is independent of earlier runs", () => {
    const ran = runAll(scenario("exhausted"));
    const fresh = scenario("exhausted");
    expect(ran.dead).toHaveLength(1);
    expect(fresh.dead).toHaveLength(0);
    expect(fresh.jobs[0].state).toBe("ready");
    expect(fresh.now).toBe(0);
  });
  it("engine functions do not mutate their input", () => {
    const w = scenario("retry-then-success");
    const snapshot = JSON.stringify(w);
    runAll(w);
    advance(w, 10_000);
    expect(JSON.stringify(w)).toBe(snapshot);
  });
});

describe("concurrency illustration", () => {
  const jobs = [
    { id: "A", durationMs: 4000 },
    { id: "B", durationMs: 1000 },
    { id: "C", durationMs: 3000, failsOnce: true },
    { id: "D", durationMs: 1000 },
    { id: "E", durationMs: 2000 },
    { id: "F", durationMs: 1000 },
  ];
  it("one worker: retry re-enters behind newer jobs", () => {
    expect(simulateConcurrency(jobs, 1, 1000).completionOrder.join("")).toBe("ABDEFC");
  });
  it("several workers finish out of submission order", () => {
    const order = simulateConcurrency(jobs, 3, 1000).completionOrder.join("");
    expect(order).not.toBe("ABCDEF");
    expect(order).toHaveLength(6);
  });
});

describe("separation of simulation and production code", () => {
  it("sim modules never import the API client or use the network", () => {
    const dir = join(__dirname, "../sim");
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/lib\/client|lib\/connection|\bfetch\s*\(|XMLHttpRequest|WebSocket|process\.env|import\.meta\.env/);
    }
  });
});
