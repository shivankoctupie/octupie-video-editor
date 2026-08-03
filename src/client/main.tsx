import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import "@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css";
import "./app.css";

/*
 * Client entry. StrictMode is deliberately not used: the third-party timeline engine and
 * react-virtualized do not tolerate development double-invoked effects cleanly, and this app
 * drives real <video> elements whose play/pause lifecycle must not be double-run.
 */
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
