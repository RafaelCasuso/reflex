/**
 * @reflex/adapter-claude-code — Claude Code host translation only.
 *
 * Pure: host events in, canonical contracts and edit plans out. This package
 * performs no I/O and makes no decision. In Gate G1.5 it observes; it never
 * answers the host.
 */
export {
  DEFAULT_SCOPE,
  SETTINGS_SCOPES,
  managedSettingsPaths,
  settingsPath,
  type ScopeRoots,
  type SettingsScope,
} from "./detect.js";

export {
  TOOL_EVENTS,
  readHookInput,
  type ClaudeHookEvent,
  type ClaudeIgnoredEvent,
  type ClaudeToolEvent,
  type ClaudeTurnEndedEvent,
  type HookInputFailure,
  type HookInputResult,
  type ToolEventName,
} from "./hook-input.js";

export { deriveActionId, deriveSessionId, randomActionId } from "./identity.js";

export { toObservationRecord } from "./observe.js";

export {
  HOOK_TIMEOUT_SECONDS,
  MANAGED_MARKER,
  OBSERVED_EVENTS,
  buildHookCommand,
  inspectSettings,
  planInstall,
  planUninstall,
  type InstallPlan,
  type SettingsInspection,
  type UninstallPlan,
} from "./settings.js";

export {
  classifyByName,
  parseToolName,
  toCanonicalAction,
  type TranslationContext,
} from "./translate.js";
