import { useCallback } from "react";
import { ErrorNotice } from "@/components/ErrorNotice";
import { RequireConnection } from "@/components/RequireConnection";
import { StatsDisclaimer, StatsTable } from "@/components/StatsTable";
import { Button, Spinner } from "@/components/ui";
import type { AdminClient } from "@/lib/client";
import { useRemote } from "@/lib/useRemote";

function Live({ client }: { client: AdminClient }) {
  const load = useCallback((s: AbortSignal) => client.listQueues(s), [client]);
  const { data, error, loading, refresh } = useRemote(load);
  return (
    <>
      <Button onClick={refresh} disabled={loading}>Refresh</Button>
      {error && <ErrorNotice error={error} onRetry={refresh} />}
      {!data && loading && <Spinner />}
      {data && <StatsTable queues={data} />}
      <StatsDisclaimer />
      <p className="text-xs text-muted-foreground">
        Queues are fixed by the admin API’s configuration; this console cannot add queues or change worker settings.
      </p>
    </>
  );
}

export function Queues() {
  return (
    <>
      <h1 className="text-xl font-semibold">Queues</h1>
      <RequireConnection>{(c) => <Live client={c} />}</RequireConnection>
    </>
  );
}
