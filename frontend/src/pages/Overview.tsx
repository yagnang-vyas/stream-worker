import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { ErrorNotice } from "@/components/ErrorNotice";
import { RequireConnection } from "@/components/RequireConnection";
import { StatsDisclaimer, StatsTable } from "@/components/StatsTable";
import { Badge, Button, Card, Spinner } from "@/components/ui";
import type { AdminClient } from "@/lib/client";
import { formatAge } from "@/lib/format";
import { useRemote } from "@/lib/useRemote";
import { useCallback } from "react";

const POLL_OPTIONS = [
  { label: "Off", ms: null },
  { label: "15 s", ms: 15_000 },
  { label: "30 s", ms: 30_000 },
  { label: "60 s", ms: 60_000 },
] as const;

function Live({ client }: { client: AdminClient }) {
  const [pollMs, setPollMs] = useState<number | null>(null);
  const load = useCallback((s: AbortSignal) => client.listQueues(s), [client]);
  const { data, error, loading, lastSuccess, refresh } = useRemote(load, pollMs);

  const total = (k: "length" | "pending" | "consumers" | "delayed" | "dead") =>
    (data ?? []).reduce((n, q) => n + q[k], 0);
  const ages = (data ?? []).map((q) => q.oldest_pending_age_ms).filter((a): a is number => a !== null);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={refresh} disabled={loading} aria-label="Refresh">
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden /> Refresh
        </Button>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Auto-refresh
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={pollMs ?? ""}
            onChange={(e) => setPollMs(e.target.value ? Number(e.target.value) : null)}
          >
            {POLL_OPTIONS.map((o) => (
              <option key={o.label} value={o.ms ?? ""}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted-foreground">
          {lastSuccess ? `Last successful refresh ${lastSuccess.toLocaleTimeString()}` : "No successful refresh yet"}
        </span>
      </div>

      {error && <ErrorNotice error={error} onRetry={refresh} />}
      {!data && loading && <Spinner label="Loading queues" />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {[
              ["Queues", data.length],
              ["Length", total("length")],
              ["Pending", total("pending")],
              ["Delayed", total("delayed")],
              ["Dead", total("dead")],
              ["Oldest pending", formatAge(ages.length ? Math.max(...ages) : null)],
            ].map(([label, value]) => (
              <Card key={label} className="p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 font-mono text-lg">{value}</p>
              </Card>
            ))}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Badge tone={error ? "warn" : "ok"}>{error ? "Stale data" : "Admin API reachable"}</Badge>
            <span className="text-muted-foreground">
              {total("consumers")} consumer(s) registered in the consumer groups
            </span>
          </div>
          <StatsTable queues={data} />
          <StatsDisclaimer />
        </>
      )}
    </>
  );
}

export function Overview() {
  return (
    <>
      <h1 className="text-xl font-semibold">Overview</h1>
      <RequireConnection>{(client) => <Live client={client} />}</RequireConnection>
    </>
  );
}
