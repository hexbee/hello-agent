// Isolated services factory — §4.3 / §4.4 / §5.2.
// Everything CLI-related is bypassed: agentDir redirected to app-private dir,
// settings in-memory, models/credentials/sessions in app-owned paths, all
// default resource discovery squashed, PermissionManager as the ONLY inline
// extension factory.

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { CredentialStore as PiCredentialStore } from "@earendil-works/pi-ai";
import type { AgentHostPaths, TrustLevel } from "./host.js";
import { RESTRICTED_TOOL_ALLOWLIST } from "./permission-manager.js";

const TRUSTED_TOOLS = ["read", "edit", "write", "bash", "grep", "find", "ls"];

export function createIsolatedModelRuntime(
  paths: AgentHostPaths,
  credentials?: PiCredentialStore,
): Promise<ModelRuntime> {
  // §4.4: no authPath → no ~/.pi/agent/auth.json. §8: credentials go through
  // the app-owned store (safeStorage-backed in Electron; in-memory in probes).
  return ModelRuntime.create({
    credentials: credentials ?? new InMemoryCredentialStore(),
    modelsPath: paths.modelsPath,
    modelsStorePath: paths.modelsStorePath,
    allowModelNetwork: false,
  });
}

export function makeServicesFactory(opts: {
  paths: AgentHostPaths;
  modelRuntime: ModelRuntime;
  /** Named inline extension — shows as <inline:permission-manager>. §4.3 */
  permissionExtension: InlineExtension;
  trust: TrustLevel;
  /** Probe seam only (e.g. watchdog hang injection); never used by the app. */
  extraExtensions?: InlineExtension[];
}): CreateAgentSessionRuntimeFactory {
  return async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: opts.paths.agentDir,
      settingsManager: SettingsManager.inMemory(),
      modelRuntime: opts.modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [opts.permissionExtension, ...(opts.extraExtensions ?? [])],
      },
    });

    const tools = opts.trust === "restricted" ? RESTRICTED_TOOL_ALLOWLIST : TRUSTED_TOOLS;

    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
}
