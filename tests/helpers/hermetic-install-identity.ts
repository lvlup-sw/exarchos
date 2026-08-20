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
 * ONE fixed directory, not `mkdtemp`. Setup files are evaluated per test file
 * under vitest's isolation, so a fresh temp directory here meant a fresh
 * directory per file: a single full run left 6,795 of them in `/tmp`, none ever
 * removed. A stable path is created once and reused, which is safe because
 * nothing asserts on its contents — every test that cares about the lock stubs
 * `EXARCHOS_INSTALL_STATE_DIR` to its own directory with `vi.stubEnv`, which
 * runs after this module and is undone on teardown.
 *
 * Set UNCONDITIONALLY. Honouring a caller-supplied value would let a stray
 * export in a shell or a CI job point the whole suite at a real directory.
 */
const SCRATCH = path.join(os.tmpdir(), 'exarchos-test-install-identity');
fs.mkdirSync(SCRATCH, { recursive: true });
process.env['EXARCHOS_INSTALL_STATE_DIR'] = SCRATCH;
