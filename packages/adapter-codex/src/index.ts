/**
 * @reflex/adapter-codex — Codex host translation only.
 *
 * Pure: host events in, canonical contracts and edit plans out. This package
 * performs no I/O and makes no decision. What it knows of the host comes from
 * Codex's documentation ("Hooks", 2026-09-27) and is marked as such until a
 * live run confirms it (`docs/codex-hook.md`).
 */
export {
  DEFAULT_HOOK_SCOPE,
  HOOK_SCOPES,
  codexDirectory,
  configFilePath,
  hooksFilePath,
  type HookScope,
  type ScopeRoots,
} from "./detect.js";

export {
  ENABLE_LINE,
  inspectConfig,
  planDisableHooks,
  planEnableHooks,
  type CodexConfigInspection,
  type FeaturePlan,
} from "./features.js";

export {
  TOOL_EVENTS,
  readHookInput,
  type CodexHookEvent,
  type CodexIgnoredEvent,
  type CodexToolEvent,
  type CodexTurnEndedEvent,
  type HookInputFailure,
  type HookInputResult,
  type ToolEventName,
} from "./hook-input.js";

export {
  HOOK_TIMEOUT_SECONDS,
  MANAGED_MARKER,
  OBSERVED_EVENTS,
  buildHookCommand,
  inspectHooksFile,
  planInstall,
  planUninstall,
  type HooksFileInspection,
  type InstallPlan,
  type UninstallPlan,
} from "./hooks-config.js";

export { deriveActionId, deriveSessionId, randomActionId } from "./identity.js";

export { toObservationRecord } from "./observe.js";

export {
  classifyByName,
  operandsOf,
  parseToolName,
  readPatch,
  toCanonicalAction,
  type PatchReading,
  type TranslationContext,
} from "./translate.js";
