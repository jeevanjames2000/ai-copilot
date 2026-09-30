/**
 * Ad-hoc sign the macOS app bundle.
 *
 * Without this the app ships with NO signature at all. On Apple Silicon macOS
 * refuses to execute an unsigned binary and reports it to the user as
 * "AI Copilot is damaged and can't be opened" — which is misleading: nothing
 * is corrupt, it simply has no signature to check.
 *
 * `--sign -` is an ad-hoc signature: it satisfies the "must be signed" rule
 * without an Apple Developer account. It does NOT remove the first-run
 * Gatekeeper prompt (that needs a paid Developer ID plus notarisation), so
 * recipients still right-click → Open once. See INSTALL.md.
 *
 * Runs after packing and before the dmg/zip is assembled, so the signed bundle
 * is what gets distributed.
 */

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`  • ad-hoc signing  ${appPath}`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: 'inherit',
    });
    // Fail loudly here rather than shipping a bundle that won't launch.
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
      stdio: 'inherit',
    });
    console.log('  • ad-hoc signature verified');
  } catch (e) {
    throw new Error(
      `Ad-hoc signing failed: ${e.message}\n` +
        'Without a signature the app will be reported as "damaged" on Apple Silicon.'
    );
  }
};
