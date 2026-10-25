import { useCallback, useMemo, useState } from "react";
import { ErrorNotice } from "@/components/ErrorNotice";
import { RequireConnection } from "@/components/RequireConnection";
import { Banner, Button, Card, EmptyState, inputCls, Mono, Spinner } from "@/components/ui";
import type { AdminClient } from "@/lib/client";
import { formatEpochMs } from "@/lib/format";
import { useRemote } from "@/lib/useRemote";

function Live({ client }: { client: AdminClient }) {
  const queues = useRemote(useCallback((s: AbortSignal) => client.listQueues(s), [client]));
  const [picked, setPicked] = useState("");
  const [term, setTerm] = useState("");
  const name = picked || queues.data?.[0]?.name || "";
  const load = useCallback(
    (s: AbortSignal) => (name ? client.listDead(name, { limit: 500 }, s) : Promise.resolve(null)),
    [client, name],
  );
  const dead = useRemote(load);
  const rows = useMemo(() => {
    const t = term.trim().toLowerCase();
    return (dead.data?.items ?? []).filter(
      (e) => !t || [e.id, e.task, e.error_type, e.entry_id].some((v) => v?.toLowerCase().includes(t)),
    );
  }, [dead.data, term]);

  return (
    <>
      <Banner title="What can be explored">
        <p>
          The admin API exposes only dead-letter entries per job. Ready, pending and delayed jobs and completed-job
          history are not available, so they are not listed here. This view searches the first 500 dead entries of the
          selected queue (metadata only; payloads are never loaded).
        </p>
      </Banner>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium">
          Queue
          <select
            className="mt-1 block h-9 rounded-md border border-border bg-background px-2 font-mono text-sm"
            value={name}
            onChange={(e) => setPicked(e.target.value)}
          >
            {(queues.data ?? []).map((q) => <option key={q.name}>{q.name}</option>)}
          </select>
        </label>
        <label className="grow text-xs font-medium">
          Filter by job id, task or error type
          <input className={`${inputCls} mt-1 font-mono`} value={term} onChange={(e) => setTerm(e.target.value)} />
        </label>
        <Button onClick={dead.refresh} disabled={dead.loading}>Refresh</Button>
      </div>
      {queues.error && <ErrorNotice error={queues.error} onRetry={queues.refresh} />}
      {dead.error && <ErrorNotice error={dead.error} onRetry={dead.refresh} />}
      {!dead.data && dead.loading && <Spinner />}
      {dead.data && (
        <Card className="overflow-x-auto">
          {rows.length === 0 ? (
            <EmptyState title="No matching dead jobs" />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Job id</th>
                  <th className="px-3 py-2 font-medium">Task</th>
                  <th className="px-3 py-2 font-medium">Attempt</th>
                  <th className="px-3 py-2 font-medium">Error type</th>
                  <th className="px-4 py-2 font-medium">Failed at</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.entry_id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2"><Mono>{e.id ?? e.entry_id}</Mono></td>
                    <td className="px-3 py-2"><Mono>{e.task ?? "—"}</Mono></td>
                    <td className="px-3 py-2 font-mono text-xs">{e.attempt ?? "?"}/{e.max_attempts ?? "?"}</td>
                    <td className="px-3 py-2"><Mono>{e.error_type ?? "—"}</Mono></td>
                    <td className="px-4 py-2 font-mono text-xs">{formatEpochMs(e.failed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}

export function JobExplorer() {
  return (
    <>
      <h1 className="text-xl font-semibold">Job Explorer</h1>
      <RequireConnection>{(c) => <Live client={c} />}</RequireConnection>
    </>
  );
}
