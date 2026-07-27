import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root.js";

// Remotion bundler entry. Bundled for the browser; must not import node APIs.
registerRoot(RemotionRoot);
