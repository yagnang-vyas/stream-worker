import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Banner, Button, Card, CardHeader, Field, inputCls, Mono, SimBadge } from "../ui";
import { retrySchedule, validateBackoff, type BackoffConfig, type Jitter } from "@/sim/backoff";

export function BackoffLab() {
  const [base, setBase] = useState("1");
  const [cap, setCap] = useState("300");
  const [attempts, setAttempts] = useState("8");
  const [jitter, setJitter] = useState<Jitter>("full");
  const [seed, setSeed] = useState(1);

  const cfg: BackoffConfig = { base: Number(base), cap: Number(cap), jitter };
  const n = Number(attempts);
  const errors = [
    ...(base.trim() === "" || cap.trim() === "" ? ["base and maximum delay are required"] : validateBackoff(cfg)),
    ...(!Number.isInteger(n) || n < 1 || n > 30 ? ["attempts must be a whole number from 1 to 30"] : []),
  ];
  const rows = useMemo(() => (errors.length ? [] : retrySchedule(cfg, n, seed)), [errors.length, cfg.base, cfg.cap, cfg.jitter, n, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const chart = rows.map((r) => ({
    name: `after #${r.attempt}`,
    ceiling: Number(r.ceiling.toFixed(3)),
    simulated: Number(r.delay.toFixed(3)),
  }));

  return (
    <div className="space-y-4">
      <Banner tone="sim" title="Formulas from the real implementation">
        <p>
          <Mono>ceiling = min(cap, base · 2^(attempt−1))</Mono>. <Mono>full</Mono> jitter samples uniformly in [0, ceiling],{" "}
          <Mono>equal</Mono> in [ceiling/2, ceiling], <Mono>none</Mono> uses the ceiling. The browser code is checked against
          values generated from <Mono>streamworker.ExponentialBackoff</Mono>. Jitter samples shown here are simulated from a
          seeded generator, and the production retry scheduler is not run.
        </p>
      </Banner>
      <Card>
        <CardHeader title="Retry and backoff lab"><SimBadge /></CardHeader>
        <div className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Base delay (s)" htmlFor="bo-base"><input id="bo-base" className={inputCls} value={base} onChange={(e) => setBase(e.target.value)} /></Field>
            <Field label="Maximum delay (s)" htmlFor="bo-cap"><input id="bo-cap" className={inputCls} value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
            <Field label="Attempts (max_attempts)" htmlFor="bo-n"><input id="bo-n" className={inputCls} value={attempts} onChange={(e) => setAttempts(e.target.value)} /></Field>
            <Field label="Jitter" htmlFor="bo-jitter">
              <select id="bo-jitter" className={inputCls} value={jitter} onChange={(e) => setJitter(e.target.value as Jitter)}>
                <option value="full">full</option>
                <option value="equal">equal</option>
                <option value="none">none</option>
              </select>
            </Field>
          </div>
          {errors.length > 0 && (
            <Banner tone="error" title="Invalid configuration"><ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Banner>
          )}
          <Button onClick={() => setSeed((s) => s + 1)} disabled={jitter === "none"}>Resample simulated jitter</Button>
        </div>
      </Card>

      {rows.length > 0 && (
        <>
          <Card>
            <CardHeader title="Delay after each failed attempt (seconds)"><SimBadge /></CardHeader>
            <div className="h-64 p-3" role="img" aria-label="Bar chart of retry delays per failed attempt">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                  <Legend />
                  <Bar dataKey="ceiling" name="ceiling (max)" fill="hsl(var(--muted-foreground))" />
                  <Bar dataKey="simulated" name="simulated delay" fill="hsl(var(--accent))" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Retry schedule for a job that fails every attempt</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Failed attempt</th>
                  <th className="px-3 py-2 font-medium">Range (s)</th>
                  <th className="px-3 py-2 font-medium">Simulated delay (s)</th>
                  <th className="px-4 py-2 font-medium">Next</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.attempt} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-mono">{r.attempt}</td>
                    <td className="px-3 py-2 font-mono">{r.min.toFixed(2)} – {r.max.toFixed(2)}</td>
                    <td className="px-3 py-2 font-mono">{r.delay.toFixed(2)}</td>
                    <td className="px-4 py-2 font-mono">attempt {r.nextAttempt}</td>
                  </tr>
                ))}
                <tr>
                  <td className="px-4 py-2 font-mono">{n}</td>
                  <td className="px-3 py-2 text-muted-foreground" colSpan={2}>retry budget exhausted</td>
                  <td className="px-4 py-2 font-mono text-bad">dead-lettered</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
