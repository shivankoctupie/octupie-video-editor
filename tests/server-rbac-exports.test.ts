import { describe, it, expect } from "vitest";
import { authorize, isWorkflowAction, WORKFLOW_ACTIONS, actionsForRole } from "../src/workflow/rbac.js";
import type { WorkflowAction, WorkflowRole } from "../src/workflow/rbac.js";

// Type-level regression for the build/typecheck gate: src/server/http.ts imports
// `type WorkflowAction` from ../workflow/rbac.js to build its RouteAction union. If that
// re-export is ever dropped again (the failure this test guards), these annotations stop
// resolving and `npm run typecheck` / `npm run build` fail here as well as in http.ts.
const guardAction: WorkflowAction = "view";
const guardRole: WorkflowRole = "admin";

describe("workflow/rbac public surface the server depends on", () => {
  it("re-exports the WorkflowAction/WorkflowRole types and the action list", () => {
    expect(guardAction).toBe("view");
    expect(guardRole).toBe("admin");
    expect(WORKFLOW_ACTIONS.length).toBeGreaterThan(0);
    for (const a of WORKFLOW_ACTIONS) expect(isWorkflowAction(a)).toBe(true);
  });

  it("keeps default-deny semantics: admin holds every action, viewer holds only view", () => {
    for (const a of WORKFLOW_ACTIONS) expect(authorize("admin", a)).toBe(true);
    expect(actionsForRole("viewer")).toEqual(["view"]);
    expect(authorize("viewer", "publish")).toBe(false);
    expect(authorize("nope", "view")).toBe(false);
  });
});
