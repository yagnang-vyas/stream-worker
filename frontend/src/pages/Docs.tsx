import type { ReactNode } from "react";
import { Card, Mono } from "@/components/ui";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="space-y-2 p-4 text-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="space-y-2 text-muted-foreground [&_strong]:text-foreground">{children}</div>
    </Card>
  );
}

export function Docs() {
  return (
    <>
      <h1 className="text-xl font-semibold">Documentation</h1>
      <Section title="What this console is">
        <p>
          A read-mostly operations view over the optional StreamWorker admin API, plus a browser-only Playground. The
          library itself works without it: <Mono>pip install streamworker</Mono> needs no Node.js.
        </p>
      </Section>
      <Section title="Delivery guarantees">
        <p><strong>At-least-once.</strong> A job can run more than once (for example a worker crashes after a side effect but before the ack), so handlers must be idempotent.</p>
        <p><strong>No ordering</strong> when concurrency is above one; retries re-enter behind newer jobs.</p>
        <p><strong>Durability</strong> is whatever your Redis provides. Without AOF, a Redis crash can lose recent jobs.</p>
        <p><strong>Enqueue idempotency</strong> (<Mono>idempotency_key</Mono>) dedupes enqueues within a TTL only; it is not exactly-once execution.</p>
      </Section>
      <Section title="Queue statistics">
        <p>Counts are a snapshot of current state from <Mono>Queue.stats()</Mono>; there is no job history, throughput or success rate.</p>
      </Section>
      <Section title="Dead-letter operations">
        <p><strong>Requeue</strong> moves a dead job back to the ready stream and resets its attempt to 1; the handler may run again.</p>
        <p><strong>Purge</strong> permanently deletes one dead entry. There is no bulk purge in this console.</p>
      </Section>
      <Section title="Connecting securely">
        <p>The admin API authenticates with one shared <Mono>X-API-Key</Mono>; there are no per-user roles. The key is kept in memory only and cleared on sign-out or reload.</p>
        <p>The admin API sends no CORS headers. Serve the built console and proxy <Mono>/api</Mono> to the admin API from the same origin over HTTPS (see <Mono>frontend/README.md</Mono>), and restrict the proxy to that single upstream.</p>
      </Section>
    </>
  );
}
