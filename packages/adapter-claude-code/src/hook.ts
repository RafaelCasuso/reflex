/**
 * Hot-path entry point: `@reflex/adapter-claude-code/hook`.
 *
 * The host starts a new process for every hook call. This entry exposes only
 * what that process needs, so it never loads the settings editor (and its
 * JSON parser) that `rfx init` uses.
 */
export { readHookInput, type ClaudeHookEvent } from "./hook-input.js";
export { toObservationRecord } from "./observe.js";
export type { TranslationContext } from "./translate.js";
