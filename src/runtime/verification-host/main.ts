/** Explicit standalone verifier entry never starts through a governor fallback. */
import { startVerificationHost } from './server.js';
import { VERIFIER_VERSION } from '../../contract/verification/harness-verification.js';

if (process.argv.length === 3 && process.argv[2] === '--identity') {
  process.stdout.write(JSON.stringify({ component: 'verifier', version: VERIFIER_VERSION, buildIdentity: Reflect.get(globalThis, '__verifierBuildIdentity__') }) + '\n');
} else {
  try {
    const path = process.argv[3];
    if (process.argv.length !== 4 || process.argv[2] !== '--config' || path === undefined) throw new Error('Expected --config with protected provisioning path');
    const host = await startVerificationHost(path);
    process.stdout.write('VERIFIER_READY\n');
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; void host.close().then(() => process.exit(0), () => process.exit(2)); } };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch {
    process.stderr.write('Verifier unavailable: protected provisioning or Linux confinement is invalid\n');
    process.exitCode = 2;
  }
}
