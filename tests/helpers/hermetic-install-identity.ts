import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Keep the install-identity TOFU lock out of the developer's real home.
 *
 * The lock is keyed to the INSTALLATION rather than to the event store, so it
 * no longer follows a test's temp `stateDir` the way it used to. That is the
 * point — freshness must not vary with `WORKFLOW_STATE_DIR` — but it means any
 * test that dispatches a mutating action under an "installed" posture would
 * otherwise publish a lock into `~/.exarchos/install`.
 *
 * A checkout of THIS repo on a machine that also has the Exarchos plugin
 * installed detects as `installed` (posture keys on the plugin cache existing,
 * not on whether the running code IS that install), so this is the ordinary
 * developer configuration, not an exotic one.
 *
 * Redirecting the directory per test process makes the suite hermetic without
 * weakening the production resolution order.
 */
if (process.env['EXARCHOS_INSTALL_STATE_DIR'] === undefined) {
  process.env['EXARCHOS_INSTALL_STATE_DIR'] = fs.mkdtempSync(
    path.join(os.tmpdir(), 'exarchos-test-install-identity-'),
  );
}
