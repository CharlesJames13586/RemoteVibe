/**
 * scripts/notarize.js — electron-builder `afterSign` hook.
 *
 * Runs automatically after `npm run dist` finishes code-signing the .app
 * with the "Developer ID Application" certificate. Submits the app to
 * Apple's notary service and staples the resulting ticket, so Gatekeeper
 * doesn't show "Apple could not verify this app is free of malware" when
 * a user downloads/double-clicks the dmg.
 *
 * Requires these env vars to be set before running `npm run dist` (see
 * README's "打包 Mac Agent" section for how to obtain each one):
 *   APPLE_ID                    — your Apple ID email
 *   APPLE_APP_SPECIFIC_PASSWORD — generated at appleid.apple.com (Security
 *                                 → App-Specific Passwords), NOT your
 *                                 normal Apple ID password
 *   APPLE_TEAM_ID                — found on developer.apple.com/account
 *                                 (Membership page, "Team ID")
 *
 * If any of these are missing, this hook skips notarization (no-op) so
 * local unsigned/signed-only builds for personal testing still work.
 */
const { notarize } = require('@electron/notarize');

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Skipping — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] Submitting ${appPath} to Apple (this can take a few minutes)…`);
  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] Done — ticket stapled.');
};
