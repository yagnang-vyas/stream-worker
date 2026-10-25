import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Connection } from "./pages/Connection";
import { DeadLetter } from "./pages/DeadLetter";
import { Docs } from "./pages/Docs";
import { JobExplorer } from "./pages/JobExplorer";
import { Overview } from "./pages/Overview";
import { QueueDetail } from "./pages/QueueDetail";
import { Queues } from "./pages/Queues";

// The playground pulls in the charting library; load it only when visited.
const Playground = lazy(() => import("./pages/Playground").then((m) => ({ default: m.Playground })));

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="queues" element={<Queues />} />
        <Route path="queues/:name" element={<QueueDetail />} />
        <Route path="jobs" element={<JobExplorer />} />
        <Route path="dead" element={<DeadLetter />} />
        <Route path="dead/:name" element={<DeadLetter />} />
        <Route
          path="playground"
          element={
            <Suspense fallback={<p className="text-sm text-muted-foreground">Loading playground…</p>}>
              <Playground />
            </Suspense>
          }
        />
        <Route path="connection" element={<Connection />} />
        <Route path="docs" element={<Docs />} />
        <Route path="*" element={<Overview />} />
      </Route>
    </Routes>
  );
}
