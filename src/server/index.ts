/**
 * Product server: a durable, multi-user, local-first surface over the deterministic
 * editing engine. A transactional SQLite repository, content-addressed storage, token
 * auth with RBAC, safe streaming uploads, a REST API, and a static browser app. Render
 * and QA run off the request path via the worker. See `app.ts` for wiring and
 * `routes.ts` for the API surface.
 */

export * from "./config.js";
export * from "./auth.js";
export * from "./upload.js";
export * from "./plans.js";
export * from "./compare.js";
export * from "./http.js";
export * from "./routes.js";
export * from "./app.js";
export * from "./db/index.js";
export * from "./storage/index.js";
export {
  runWorkerOnce,
  runWorkerLoop,
  createWorkerRuntime,
  defaultRunners,
  renderRunner,
  type PlanRenderer,
  type WorkerDeps,
  type WorkerRuntimeOptions,
  type JobRunner,
  type JobOutcome,
} from "./worker.js";
export {
  prepareRenderAssets,
  type PrepareRenderAssetsInput,
  type PreparedRenderAssets,
} from "./renderAssets.js";
