/**
 * Notifications (parity phase 8).
 *
 * A `NotificationAdapter` turns a bounded notification into a delivery record. The
 * only shipped adapter is `file`: it atomically appends a bounded, data-only line
 * to a local outbox and returns a delivery record. It NEVER touches the network.
 * External adapters (email, chat, webhook) exist as this interface only; none is
 * implemented, so nothing here can leave the machine.
 */

import { join, resolve } from "node:path";
import {
  defaultWorkflowFs,
  type WorkflowFs,
} from "./store.js";
import {
  DELIVERY_RECORD_FORMAT,
  parseNotification,
  type DeliveryRecordValue,
  type NotificationValue,
} from "./schemas.js";

/** An adapter delivers one notification and returns a validated delivery record. */
export interface NotificationAdapter {
  readonly id: string;
  deliver(notification: NotificationValue): Promise<DeliveryRecordValue>;
}

/** Thrown for a notification gate failure (invalid artifact). */
export class NotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationError";
  }
}

export interface FileNotificationOptions {
  /** Absolute path to the append-only outbox (newline-delimited JSON). */
  outboxPath: string;
  fs?: WorkflowFs;
  now?: Date;
}

/**
 * The default, fully local `file` adapter. It appends the bounded notification and
 * the delivery record as one JSON line to the outbox, rewriting the file atomically
 * so an append is crash-safe. No network, ever.
 */
export function createFileNotificationAdapter(opts: FileNotificationOptions): NotificationAdapter {
  const fs = opts.fs ?? defaultWorkflowFs;
  return {
    id: "file",
    deliver(notification: NotificationValue): Promise<DeliveryRecordValue> {
      const parsed = parseNotification(notification);
      if (!parsed.ok || !parsed.data) {
        return Promise.reject(new NotificationError(`Invalid notification: ${parsed.errors.join("; ")}`));
      }
      const n = parsed.data;
      const now = opts.now ?? new Date();
      const record: DeliveryRecordValue = {
        format: DELIVERY_RECORD_FORMAT,
        id: `delivery-${n.id}`,
        notificationId: n.id,
        channel: "file",
        status: "delivered",
        deliveredAt: now.toISOString(),
      };
      // Append by rewriting the whole file atomically (temp + rename): the existing
      // outbox plus one new bounded line. Data only.
      const existing = fs.exists(opts.outboxPath) ? fs.readText(opts.outboxPath) : "";
      const line = JSON.stringify({ notification: n, delivery: record });
      fs.ensureDir(dirnameOf(opts.outboxPath));
      fs.writeFile(opts.outboxPath, existing + line + "\n");
      return Promise.resolve(record);
    },
  };
}

/** Default outbox location under a state root. */
export function defaultOutboxPath(stateRoot: string): string {
  return join(resolve(stateRoot), "notifications", "outbox.jsonl");
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? "." : p.slice(0, i);
}
