import { Eye, EyeOff, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DeadActionDialog, type DeadAction } from "@/components/DeadActions";
import { ErrorNotice } from "@/components/ErrorNotice";
import { RequireConnection } from "@/components/RequireConnection";
import { Banner, Button, Card, EmptyState, JsonBlock, Mono, Spinner } from "@/components/ui";
import type { AdminClient } from "@/lib/client";
import { describeError } from "@/lib/errors";
import { formatEpochMs, prettyJson, truncate } from "@/lib/format";
import { useRemote } from "@/lib/useRemote";

const LIMITS = [25, 50, 100];

function Live({ client, initial }: { client: AdminClient; initial?: string }) {
  const navigate = useNavigate();
  const queues = useRemote(useCallback((s: AbortSignal) => client.listQueues(s), [client]));
  const [name, setName] = useState(initial ?? "");
  const [limit, setLimit] = useState(50);
  // cursors[i] is the cursor used to fetch page i; page 0 uses null.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealError, setRevealError] = useState<string | null>(null);
  const [action, setAction] = useState<DeadAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    if (!name && queues.data?.length) setName(initial && queues.data.some((q) => q.name === initial) ? initial : queues.data[0].name);
  }, [queues.data, name, initial]);

  const load = useCallback(
    (s: AbortSignal) => (name ? client.listDead(name, { limit, cursor }, s) : Promise.resolve(null)),
    [client, name, limit, cursor],
  );
  const page = useRemote(load);

  function resetView(next?: Partial<{ name: string; limit: number }>) {
    setCursors([null]);
    setRevealed({}); // payloads never outlive the page they were revealed on
    setRevealError(null);
    if (next?.name !== undefined) {
      setName(next.name);
      navigate(`/dead/${encodeURIComponent(next.name)}`, { replace: true });
    }
    if (next?.limit !== undefined) setLimit(next.limit);
  }

  async function reveal(entryId: string) {
    setRevealError(null);
    try {
      // Explicit operator action: re-fetch this page with include_payload=true, keep only this row.
      const p = await client.listDead(name, { limit, cursor, includePayload: true });
      const hit = p.items.find((i) => i.entry_id === entryId);
      if (!hit?.payload) throw new Error("The payload is no longer available (the entry may have been removed).");
      setRevealed((r) => ({ ...r, [entryId]: hit.payload! }));
    } catch (e) {
      setRevealError(describeError(e));
    }
  }

  const items = page.data?.items ?? [];

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium">
          Queue
          <select
            className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm font-mono"
            value={name}
            onChange={(e) => resetView({ name: e.target.value })}
          >
            {(queues.data ?? []).map((q) => (
              <option key={q.name}>{q.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium">
          Page size
          <select
            className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={limit}
            onChange={(e) => resetView({ limit: Number(e.target.value) })}
          >
            {LIMITS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <Button onClick={page.refresh} disabled={page.loading}>Refresh</Button>
      </div>

      <Banner tone="warn" title="Dead-letter entries are sensitive">
        <p>
          Payloads stay hidden until you reveal them one at a time; error messages are truncated here. Requeue and purge
          change the real queue.
        </p>
      </Banner>

      {queues.error && <ErrorNotice error={queues.error} onRetry={queues.refresh} />}
      {page.error && <ErrorNotice error={page.error} onRetry={page.refresh} />}
      {notice && (
        <Banner tone="info" title="Server response">
          <p>{notice}</p>
        </Banner>
      )}
      {revealError && <Banner tone="error" title="Could not reveal payload"><p>{revealError}</p></Banner>}

      {!page.data && page.loading && <Spinner label="Loading dead-letter entries" />}
      {page.data && items.length === 0 && (
        <Card>
          <EmptyState title="No dead-letter entries">
            {cursors.length > 1 ? "There are no further entries after this cursor." : "Nothing has been dead-lettered in this queue."}
          </EmptyState>
        </Card>
      )}
      {items.length > 0 && (
        <div className="space-y-3">
          {items.map((e) => (
            <Card key={e.entry_id} className="p-4" aria-label={`Dead entry ${e.entry_id}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm">
                    <Mono>{e.task ?? "(no task)"}</Mono>{" "}
                    <span className="text-muted-foreground">
                      attempt {e.attempt ?? "?"}/{e.max_attempts ?? "?"}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    entry <Mono>{e.entry_id}</Mono> · job <Mono>{e.id ?? "—"}</Mono> · failed {formatEpochMs(e.failed_at)}
                  </p>
                  <p className="text-sm">
                    <Mono className="text-bad">{e.error_type ?? "unknown error"}</Mono>
                    {e.error_message && <span className="text-muted-foreground"> — {truncate(e.error_message, 160)}</span>}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {revealed[e.entry_id] === undefined ? (
                    <Button size="sm" onClick={() => reveal(e.entry_id)}>
                      <Eye className="h-3.5 w-3.5" aria-hidden /> Reveal payload
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() =>
                        setRevealed((r) => {
                          const { [e.entry_id]: _drop, ...rest } = r;
                          return rest;
                        })
                      }
                    >
                      <EyeOff className="h-3.5 w-3.5" aria-hidden /> Hide payload
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setAction({ kind: "requeue", entry: e })}>
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Requeue
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setAction({ kind: "purge", entry: e })}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Purge
                  </Button>
                </div>
              </div>
              {revealed[e.entry_id] !== undefined && (
                <div className="mt-3">
                  <JsonBlock label={`Payload of ${e.entry_id}`} text={prettyJson(revealed[e.entry_id])} />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {page.data && (
        <div className="flex items-center justify-between">
          <Button
            disabled={cursors.length === 1 || page.loading}
            onClick={() => {
              setCursors((c) => c.slice(0, -1));
              setRevealed({});
            }}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">Page {cursors.length}</span>
          <Button
            disabled={!page.data.next_cursor || page.loading}
            onClick={() => {
              setCursors((c) => [...c, page.data!.next_cursor]);
              setRevealed({});
            }}
          >
            Next
          </Button>
        </div>
      )}

      {action && (
        <DeadActionDialog
          client={client}
          queue={name}
          action={action}
          onClose={() => setAction(null)}
          onDone={(m) => {
            setNotice(m);
            setAction(null);
            setRevealed({});
            page.refresh();
            queues.refresh();
          }}
        />
      )}
    </>
  );
}

export function DeadLetter() {
  const { name } = useParams();
  return (
    <>
      <h1 className="text-xl font-semibold">Dead Letter Queue</h1>
      <RequireConnection>{(c) => <Live client={c} initial={name} />}</RequireConnection>
    </>
  );
}
