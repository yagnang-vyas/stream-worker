import { useRef, useState } from "react";
import { Banner, Button, Dialog, Field, inputCls, Mono } from "./ui";
import type { AdminClient } from "@/lib/client";
import { describeError } from "@/lib/errors";
import type { DeadJobDto } from "@/lib/types";

export type DeadAction = { kind: "requeue" | "purge"; entry: DeadJobDto };

/**
 * Confirmation dialog for the two destructive dead-letter operations.
 * `inFlight` makes a second submission impossible while the request is pending.
 */
export function DeadActionDialog({
  client,
  queue,
  action,
  onClose,
  onDone,
}: {
  client: AdminClient;
  queue: string;
  action: DeadAction;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { kind, entry } = action;
  const [typed, setTyped] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const ready = kind === "requeue" ? ack : typed === entry.entry_id;

  async function submit() {
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (kind === "requeue") {
        const r = await client.requeueDead(queue, entry.entry_id);
        onDone(`Server accepted the requeue. New stream entry id: ${r.entry_id}. The job is back in the ready stream; it has not been confirmed as processed.`);
      } else {
        await client.purgeDead(queue, entry.entry_id);
        onDone(`Server deleted dead-letter entry ${entry.entry_id} (HTTP 204).`);
      }
    } catch (e) {
      setError(describeError(e));
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog title={kind === "requeue" ? "Requeue dead job" : "Purge dead job"} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          Queue <Mono>{queue}</Mono> · entry <Mono>{entry.entry_id}</Mono>
          {entry.id && <> · job <Mono>{entry.id}</Mono></>}
          {entry.task && <> · task <Mono>{entry.task}</Mono></>}
        </p>
        {kind === "requeue" ? (
          <>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>The job is moved back to the <strong>ready stream</strong> and removed from the dead-letter stream.</li>
              <li>Its <strong>attempt count resets to 1</strong>, so it gets a full retry budget again.</li>
              <li>The handler <strong>may execute more than once</strong> (delivery is at-least-once); make sure it is safe to re-run.</li>
            </ul>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I understand this job will run again.</span>
            </label>
          </>
        ) : (
          <>
            <Banner tone="warn" title="This permanently deletes the selected entry">
              <p>The dead-letter entry <Mono>{entry.entry_id}</Mono> and its payload are removed and cannot be recovered.</p>
            </Banner>
            <Field label={`Type ${entry.entry_id} to confirm`} htmlFor="purge-confirm">
              <input
                id="purge-confirm"
                className={`${inputCls} font-mono`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </>
        )}
        {error && <Banner tone="error" title="Request failed"><p>{error}</p></Banner>}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={kind === "purge" ? "danger" : "primary"} disabled={!ready || busy} onClick={submit}>
            {busy ? "Working…" : kind === "requeue" ? "Requeue job" : "Delete entry"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
