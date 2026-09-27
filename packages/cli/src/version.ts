/**
 * The CLI's own version. A constant rather than a read of package.json, so
 * that the hook path pays nothing for it; `version.test.ts` holds it to the
 * manifest.
 */
export const CLI_VERSION = "0.0.0";
