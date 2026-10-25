import { Play, RotateCcw, SkipForward, Timer, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Lanes, Timeline, WorkerStrip } from "./SimView";
import { Banner, Badge, Button, Card, CardHeader, Field, inputCls, Mono, SimBadge } from "../ui";
import {
  advance,
  crashWorker,
  fixHandler,
  createWorld,
  purgeDead,
  registerTask,
  requeueDead,
  reviveWorker,
  runAll,
  step,
  validateConfig,
  type World,
} from "@/sim/engine";
import { loadScenario, type Scenario } from "@/sim/scenarios";

interface Props {
  scenarios: Scenario[];
  /** Show visibility timeout, worker crash/restart and the side-effect ledger. */
  recovery?: boolean;
  /** Show the dead-letter record panel with requeue/purge. */
  deadLetter?: boolean;
}

export function SimConsole({ scenarios, recovery = false, deadLetter = false }: Props) {
  const [scenarioId, setScenarioId] = useState(scenarios[0].id);
  const scenario = scenarios.find((s) => s.id === scenarioId) ?? scenarios[0];
  const [world, setWorld] = useState<World>(() => loadScenario(scenarios[0]));
  const [note, setNote] = useState("");
  const [customAdvance, setCustomAdvance] = useState("10");
  const [visibility, setVisibility] = useState(String(world.config.visibilityMs / 1000));

  const configErrors = useMemo(() => validateConfig(world.config), [world.config]);

  const load = (s: Scenario) => {
    const w = loadScenario(s);
    setWorld(w);
    setVisibility(String(w.config.visibilityMs / 1000));
    setNote("");
  };
  const apply = (fn: (w: World) => World) => {
    if (configErrors.length) return;
    setWorld(fn);
  };
  const setVis = (v: string) => {
    setVisibility(v);
    const n = Number(v);
    if (Number.isFinite(n)) setWorld((w) => ({ ...w, config: { ...w.config, visibilityMs: Math.round(n * 1000) } }));
  };
  const adv = Number(customAdvance);
  const advOk = Number.isFinite(adv) && adv >= 0;

  const unknownTasks = [...new Set(world.dead.filter((d) => d.errorType === "UnknownTask").map((d) => d.job.task))];

  return (
    <div className="space-y-4">
      <Banner tone="sim" title="Simulation, not Redis">
        <p>
          A simplified model of the documented lifecycle running in your browser with a simulated clock. No worker, Redis
          or admin API is involved, and the handler outcomes are scripted.
        </p>
      </Banner>

      <Card>
        <CardHeader title="Scenario">
          <SimBadge />
        </CardHeader>
        <div className="space-y-3 p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <Field label="Scenario" htmlFor="scenario">
              <select
                id="scenario"
                className={inputCls}
                value={scenarioId}
                onChange={(e) => {
                  setScenarioId(e.target.value);
                  load(scenarios.find((s) => s.id === e.target.value)!);
                }}
              >
                {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </Field>
            <div className="flex items-end gap-2">
              <Button onClick={() => load(scenario)}>Load example</Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{scenario.summary}</p>

          {recovery && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Visibility timeout (s)" htmlFor="vis" hint="Must be greater than the handler time, as the Worker requires.">
                <input id="vis" className={inputCls} inputMode="decimal" value={visibility} onChange={(e) => setVis(e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={world.config.handlerDedupe}
                  onChange={(e) => setWorld((w) => ({ ...w, config: { ...w.config, handlerDedupe: e.target.checked } }))}
                />
                Handler-level dedupe by job id (application code)
              </label>
            </div>
          )}
          {configErrors.length > 0 && (
            <Banner tone="error" title="Invalid configuration">
              <ul className="list-disc pl-4">{configErrors.map((e) => <li key={e}>{e}</li>)}</ul>
            </Banner>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <Button
              variant="primary"
              disabled={configErrors.length > 0}
              onClick={() => apply((w) => runAll(w))}
            >
              <Play className="h-4 w-4" aria-hidden /> Run simulation
            </Button>
            <Button
              disabled={configErrors.length > 0}
              onClick={() => {
                if (configErrors.length) return;
                const r = step(world);
                setNote(r.progressed ? `Ran: ${r.note}` : r.note);
                setWorld(r.world);
              }}
            >
              <SkipForward className="h-4 w-4" aria-hidden /> Step
            </Button>
            {[5, 30, 60].map((s) => (
              <Button key={s} disabled={configErrors.length > 0} onClick={() => apply((w) => advance(w, s * 1000))}>
                <Timer className="h-4 w-4" aria-hidden /> +{s}s
              </Button>
            ))}
            <div className="flex items-end gap-1">
              <Field label="Advance by (s)" htmlFor="adv">
                <input id="adv" className={`${inputCls} w-24`} value={customAdvance} onChange={(e) => setCustomAdvance(e.target.value)} />
              </Field>
              <Button disabled={!advOk || configErrors.length > 0} onClick={() => apply((w) => advance(w, adv * 1000))}>
                Advance
              </Button>
            </div>
            <Button onClick={() => load(scenario)}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Reset scenario
            </Button>
            <Button onClick={() => { setWorld(createWorld({}, scenario.workers ?? 2)); setNote(""); }}>
              <Trash2 className="h-4 w-4" aria-hidden /> Clear simulated jobs
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Simulated clock: <Mono>t={(world.now / 1000).toFixed(1)}s</Mono> {note && <>· {note}</>}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Simulated queue state" />
        <div className="space-y-3 p-4">
          <WorkerStrip world={world} />
          {recovery && (
            <div className="flex flex-wrap gap-2">
              {world.workers.filter((w) => w.status === "busy").map((w) => (
                <Button key={w.id} size="sm" variant="danger" onClick={() => setWorld((x) => crashWorker(x, w.id))}>
                  Kill {w.id} mid-job
                </Button>
              ))}
              {world.workers.filter((w) => w.status === "crashed").map((w) => (
                <Button key={w.id} size="sm" onClick={() => setWorld((x) => reviveWorker(x, w.id))}>
                  Restart {w.id}
                </Button>
              ))}
            </div>
          )}
          <Lanes world={world} />
        </div>
      </Card>

      {recovery && world.sideEffects.length > 0 && (
        <Card>
          <CardHeader title="Handler side effects (simulated)">
            <SimBadge />
          </CardHeader>
          <div className="space-y-2 p-4 text-sm">
            <ul className="space-y-1" aria-label="Side-effect ledger">
              {world.sideEffects.map((s, i) => (
                <li key={i}>
                  <Mono>{s.jobId}</Mono> execution {s.execution}:{" "}
                  {s.applied ? <Badge tone="warn">side effect applied</Badge> : <Badge tone="ok">skipped by handler dedupe</Badge>}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              The library guarantees <strong>at-least-once</strong> delivery, so a crash after the side effect but before
              the ack runs the handler again. Preventing a duplicate side effect is the handler’s job.
            </p>
          </div>
        </Card>
      )}

      {deadLetter && (
        <Card>
          <CardHeader title="Simulated dead-letter stream">
            <SimBadge />
          </CardHeader>
          {world.dead.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Empty. Run a failing scenario to fill it.</p>
          ) : (
            <ul className="divide-y divide-border">
              {world.dead.map((d) => (
                <li key={d.entryId} className="space-y-2 px-4 py-3 text-sm" aria-label={`Simulated dead entry ${d.entryId}`}>
                  <p>
                    <Mono>{d.job.id}</Mono> · task <Mono>{d.job.task}</Mono> · attempt {d.job.attempt}/{d.job.maxAttempts}
                  </p>
                  <p>
                    <Mono className="text-bad">{d.errorType}</Mono>: {d.errorMessage}{" "}
                    <span className="text-muted-foreground">(failed at t={(d.failedAt / 1000).toFixed(1)}s)</span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setWorld((w) => requeueDead(w, d.entryId))}>Requeue (attempt → 1)</Button>
                    <Button size="sm" variant="danger" onClick={() => setWorld((w) => purgeDead(w, d.entryId))}>Purge</Button>
                    {d.errorType !== "UnknownTask" && d.errorType !== "MalformedJob" && (
                      <Button size="sm" onClick={() => setWorld((w) => fixHandler(w, d.job.id))}>
                        Fix handler (next run succeeds)
                      </Button>
                    )}
                    {d.errorType === "UnknownTask" && (
                      <Button size="sm" onClick={() => setWorld((w) => registerTask(w, d.job.task))}>
                        Register handler for “{d.job.task}”
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            <strong>Requeue</strong> moves the job back to the ready stream with its attempt counter reset to 1, so it can
            run (and fail) again. <strong>Purge</strong> deletes the entry for good. Neither touches a real dead-letter
            stream. {unknownTasks.length > 0 && "Requeueing an unknown task fails again until a handler is registered."}
          </p>
        </Card>
      )}

      <Timeline world={world} />
    </div>
  );
}
