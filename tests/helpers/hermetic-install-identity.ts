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
// Set UNCONDITIONALLY. Honouring a caller-supplied value would let a stray
// export in a shell or a CI job point the whole suite at a real directory, and
// the tests would publish TOFU locks there — the exact leak this file exists to
// stop. A test that needs its own directory overrides it per-test with
// `vi.stubEnv`, which runs after this module and is undone on teardown.
process.env['EXARCHOS_INSTALL_STATE_DIR'] = fs.mkdtempSync(
  path.join(os.tmpdir(), 'exarchos-test-install-identity-'),
);
