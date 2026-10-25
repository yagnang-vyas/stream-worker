import { createWorld, enqueue, type Outcome, type SimConfig, type World } from "./engine";

export interface ScenarioJob {
  task: string;
  payload: string;
  maxAttempts: number;
  delayMs: number;
  idempotencyKey?: string;
  plan: Outcome[];
  malformed?: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  config?: Partial<SimConfig>;
  workers?: number;
  jobs: ScenarioJob[];
}

const job = (j: Partial<ScenarioJob> & { plan: Outcome[] }): ScenarioJob => ({
  task: "send_email",
  payload: '{"to":"ada@example.com"}',
  maxAttempts: 3,
  delayMs: 0,
  ...j,
});

export const SCENARIOS: Scenario[] = [
  {
    id: "success",
    title: "Succeeds on the first attempt",
    summary: "ready → pending → acked.",
    jobs: [job({ plan: ["success"] })],
  },
  {
    id: "retry-then-success",
    title: "Fails, then succeeds on a later attempt",
    summary: "Attempts 1 and 2 fail and are rescheduled with exponential backoff; attempt 3 succeeds.",
    jobs: [job({ plan: ["fail", "fail", "success"] })],
  },
  {
    id: "exhausted",
    title: "Exhausts its retry budget",
    summary: "Every attempt fails; the last failure moves the job to the dead-letter stream.",
    jobs: [job({ task: "process_order", payload: '{"order_id":1042}', plan: ["fail"] })],
  },
  {
    id: "delayed",
    title: "Delayed job becomes ready",
    summary: "Enqueued with a 30 s delay: it waits in the delayed set until the promoter moves it.",
    jobs: [job({ task: "generate_report", payload: '{"report":"weekly"}', delayMs: 30_000, plan: ["success"] })],
  },
  {
    id: "crash",
    title: "Worker crashes while processing",
    summary: "The only worker dies before XACK. The entry stays pending and nothing can reclaim it until a worker is restarted.",
    workers: 1,
    jobs: [job({ plan: ["crash", "success"] })],
  },
  {
    id: "recovered",
    title: "Stalled pending job is recovered",
    summary: "After the crash, worker-2 claims the entry via XAUTOCLAIM and runs it again (at-least-once).",
    jobs: [job({ plan: ["crash", "success"] })],
  },
  {
    id: "poison",
    title: "Crash loop hits the poison limit",
    summary: "max_attempts=1 and a crash: the reclaim makes deliveries (2) exceed max_attempts, so it is dead-lettered unrun.",
    workers: 3,
    jobs: [job({ maxAttempts: 1, plan: ["crash"] })],
  },
  {
    id: "unknown",
    title: "Unknown task",
    summary: "No handler is registered for the task, so it is dead-lettered immediately as UnknownTask.",
    jobs: [job({ task: "send_fax", payload: "{}", plan: ["success"] })],
  },
  {
    id: "malformed",
    title: "Malformed entry",
    summary: "The stream entry cannot be parsed, so it is dead-lettered as MalformedJob.",
    jobs: [job({ plan: ["success"], malformed: true })],
  },
];

/** Builds the initial world for a scenario: jobs enqueued, nothing executed yet. */
export function loadScenario(s: Scenario): World {
  let w = createWorld(s.config ?? {}, s.workers ?? 2);
  for (const j of s.jobs) {
    w = enqueue(w, { ...j, queue: "demo" }).world;
  }
  return w;
}
