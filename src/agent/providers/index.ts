import type { Provider, ProviderDiagnostic } from "./types.js";
import { createDeterministicProvider } from "./deterministic.js";
import { createClaudeProvider } from "./claude.js";
import { createCodexProvider } from "./codex.js";

export * from "./types.js";
export { createDeterministicProvider } from "./deterministic.js";
export { createClaudeProvider } from "./claude.js";
export { createCodexProvider } from "./codex.js";

export const PROVIDER_IDS = ["deterministic", "claude-cli", "codex-cli"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

/** Construct a provider by id. Throws on an unknown id. */
export function getProvider(id: string): Provider {
  switch (id) {
    case "deterministic":
      return createDeterministicProvider();
    case "claude-cli":
      return createClaudeProvider();
    case "codex-cli":
      return createCodexProvider();
    default:
      throw new Error(`Unknown provider '${id}'. Available: ${PROVIDER_IDS.join(", ")}`);
  }
}

/** Diagnose every provider. Used by `agent providers`. */
export async function diagnoseAll(): Promise<ProviderDiagnostic[]> {
  const providers = PROVIDER_IDS.map((id) => getProvider(id));
  return Promise.all(providers.map((p) => p.diagnose()));
}
