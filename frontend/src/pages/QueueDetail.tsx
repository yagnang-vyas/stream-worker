import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { ErrorNotice } from "@/components/ErrorNotice";
import { RequireConnection } from "@/components/RequireConnection";
import { Banner, Button, Card, CardHeader, Mono, Spinner } from "@/components/ui";
import type { AdminClient } from "@/lib/client";
import { formatAge } from "@/lib/format";
import { useRemote } from "@/lib/useRemote";

function Live({ client, name }: { client: AdminClient; name: string }) {
  const load = useCallback((s: AbortSignal) => client.getQueue(name, s), [client, name]);
  const { data, error, loading, refresh } = useRemote(load);
  const rows: [string, string, string | number][] = data
    ? [
        ["length", "Ready + pending entries in the stream", data.length],
        ["pending", "Delivered to a consumer, not yet acknowledged", data.pending],
        ["consumers", "Consumers registered in the group", data.consumers],
        ["delayed", "Waiting for their due time (retries, delayed enqueues)", data.delayed],
        ["dead", "Entries in the dead-letter stream", data.dead],
        ["oldest_pending_age_ms", "Age of the oldest unacknowledged entry", formatAge(data.oldest_pending_age_ms)],
      ]
    : [];
  return (
    <>
      <Button onClick={refresh} disabled={loading}>Refresh</Button>
      {error && <ErrorNotice error={error} onRetry={refresh} />}
      {!data && loading && <Spinner />}
      {data && (
        <Card>
          <CardHeader title="Current statistics" />
          <dl className="divide-y divide-border">
            {rows.map(([k, desc, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                <div>
                  <dt className="font-mono text-sm">{k}</dt>
                  <dd className="text-xs text-muted-foreground">{desc}</dd>
                </div>
                <dd className="font-mono text-sm" aria-label={`${k} value`}>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="border-t border-border px-4 py-3 text-sm">
            <Link className="text-accent underline" to={`/dead/${encodeURIComponent(name)}`}>
              Inspect {data.dead} dead-letter {data.dead === 1 ? "entry" : "entries"}
            </Link>
          </div>
        </Card>
      )}
      <Banner title="What the admin API does not expose">
        <p>
          There is no endpoint to list ready, pending or delayed jobs, or completed-job history. Only counts and the
          dead-letter stream are inspectable; this console does not query Redis directly.
        </p>
      </Banner>
    </>
  );
}

export function QueueDetail() {
  const { name = "" } = useParams();
  return (
    <>
      <h1 className="text-xl font-semibold">
        Queue <Mono className="text-base">{name}</Mono>
      </h1>
      <RequireConnection>{(c) => <Live client={c} name={name} />}</RequireConnection>
    </>
  );
}
