import ReactDOM from "react-dom/client";
import { Suspense, lazy } from "react";
import "dockview-react/dist/styles/dockview.css";
import "./editor/theme.css";
import { installConsoleCapture } from "./editor/store/consoleStore.js";
import { ProjectHub } from "./editor/ProjectHub.jsx";
import { useProjectStore } from "./editor/store/projectStore.js";

installConsoleCapture();

// EditorShell (and everything it transitively pulls in — dockview's panel
// components, the engine module graph, MenuBar, scene IO) is lazy-loaded
// behind a Suspense boundary. The project hub renders inside the first frame
// without paying for any of that.
const EditorShell = lazy(() =>
  import("./editor/EditorShell.jsx").then((m) => ({ default: m.EditorShell })),
);

function App() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const hubSkipped = useProjectStore((s) => s.hubSkipped);
  return rootPath || hubSkipped ? (
    <Suspense fallback={<div style={{ padding: 24, color: "#9aa3b2" }}>Loading editor…</div>}>
      <EditorShell />
    </Suspense>
  ) : (
    <ProjectHub />
  );
}

// No StrictMode: its dev-mode double-mount would tear down and re-create the
// WebGPU renderer; the engine singleton is managed explicitly instead.
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
