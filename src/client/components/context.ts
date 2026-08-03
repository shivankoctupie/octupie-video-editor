import { createContext, useContext } from "react";
import type { Me, MediaRow, VersionRow } from "../api";

export type ToastKind = "ok" | "bad" | "info";

/** App-level state shared with every panel (below the editor reducer, which is passed as props). */
export interface AppContextValue {
  projectId: string;
  me: Me;
  statusInfo: StatusInfo | null;
  media: MediaRow[];
  versions: VersionRow[];
  can: (action: string) => boolean;
  mediaById: (id: string) => MediaRow | undefined;
  mediaPath: (id: string) => string | null;
  mediaPathToId: (path: string) => string | null;
  refreshMedia: () => Promise<void>;
  refreshVersions: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  toast: (message: string, kind?: ToastKind) => void;
}

export interface StatusInfo {
  storage: { available: boolean; detail: string };
  publishing: { adapters: Array<{ id: string; enabled: boolean }>; webhookConfigured: boolean; publishingGrant: boolean };
  generation: { localImage: { verified: boolean; note: string }; localTts: { verified: boolean; note: string }; httpAdaptersConfigured: boolean };
  materialization: { web: { enabled: boolean }; drive: { enabled: boolean; tokenEnvSet: boolean } };
  grants: Array<{ action: string; grantedBy: string; expiresAt?: string }>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("AppContext missing");
  return value;
}
