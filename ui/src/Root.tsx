import App from "./App";
import { StartRunForm } from "./StartRunForm";
import { RunDashboard } from "./RunDashboard";
import { useHashRoute } from "./router";

export function Root() {
  const route = useHashRoute();
  if (route.kind === "new-run") return <StartRunForm />;
  if (route.kind === "run-dashboard") return <RunDashboard runId={route.runId} />;
  return <App refine={route.refine} />;
}

export default Root;
