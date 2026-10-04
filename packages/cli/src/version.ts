/**
 * The CLI's own version, what `rfx --version` prints. A constant rather than
 * a read of package.json, so that the hook path pays nothing for it;
 * `version.test.ts` holds it to the manifest, and a release writes the tag
 * into both before the build that is packed (`tools/release/set-version.mjs`).
 */
export const CLI_VERSION = "0.0.0";
