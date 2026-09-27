/**
 * Hot-path entry point: `@reflex/adapter-codex/hook`.
 *
 * The host starts a new process for every hook call. This entry exposes only
 * what that process needs, so it never loads the hooks-file editor (and its
 * JSON and TOML parsers) that `rfx init` uses.
 */
export {
  readHookInput,
  type CodexHookEvent,
  type CodexToolEvent,
} from "./hook-input.js";
export { toObservationRecord } from "./observe.js";
export { toCanonicalAction, type TranslationContext } from "./translate.js";
