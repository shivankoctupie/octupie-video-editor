/**
 * Role-based access control for the workflow layer (parity phase 8).
 *
 * `authorize(role, action)` is a pure, default-deny function: an action is allowed
 * only when the role's explicit allow-list contains it. An unknown role or an
 * unknown action is denied, never escalated. There is no wildcard except the one
 * the admin role is explicitly given. The role map is fixed data, so no config or
 * model reply can widen it.
 *
 *   viewer     view
 *   editor     view, edit, submit-review
 *   approver   view, decide-review
 *   publisher  view, publish
 *   admin      everything
 */

import {
  WORKFLOW_ACTIONS,
  WORKFLOW_ROLES,
  type WorkflowAction,
  type WorkflowRole,
} from "./schemas.js";

/** The explicit allow-list per role. Nothing outside a role's set is permitted. */
const ROLE_ACTIONS: Readonly<Record<WorkflowRole, readonly WorkflowAction[]>> = {
  viewer: ["view"],
  editor: ["view", "edit", "submit-review"],
  approver: ["view", "decide-review"],
  publisher: ["view", "publish"],
  admin: [...WORKFLOW_ACTIONS],
};

export function isWorkflowRole(value: unknown): value is WorkflowRole {
  return typeof value === "string" && (WORKFLOW_ROLES as readonly string[]).includes(value);
}

export function isWorkflowAction(value: unknown): value is WorkflowAction {
  return typeof value === "string" && (WORKFLOW_ACTIONS as readonly string[]).includes(value);
}

/**
 * Pure authorization check. Default deny: returns true only for a known role whose
 * allow-list contains a known action. Any unknown input returns false.
 */
export function authorize(role: unknown, action: unknown): boolean {
  if (!isWorkflowRole(role)) return false;
  if (!isWorkflowAction(action)) return false;
  return ROLE_ACTIONS[role].includes(action);
}

/** Thrown at an enforcement point when a role may not perform an action. */
export class RbacDeniedError extends Error {
  readonly role: string;
  readonly action: string;
  constructor(role: string, action: string) {
    super(`Role '${role}' is not authorized for action '${action}'.`);
    this.name = "RbacDeniedError";
    this.role = role;
    this.action = action;
  }
}

/** Enforcement point. Throws {@link RbacDeniedError} unless authorized. */
export function requireAuthorized(role: unknown, action: WorkflowAction): void {
  if (!authorize(role, action)) {
    throw new RbacDeniedError(String(role), action);
  }
}

/** The actions each role holds, for display/diagnostics. */
export function actionsForRole(role: WorkflowRole): readonly WorkflowAction[] {
  return ROLE_ACTIONS[role];
}

export { WORKFLOW_ACTIONS, WORKFLOW_ROLES } from "./schemas.js";
