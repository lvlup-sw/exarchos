import type { DispatchContext } from '../core/dispatch.js';
import { deriveLocalOperatorIdentity } from '../dispatch/caller-identity.js';

/**
 * The DispatchContext a CLI adapter actually forwards to `dispatch`.
 *
 * `buildCli` stamps `callerIdentity` from the transport rather than trusting the
 * caller to supply it — a caller cannot self-assert its own principal. Tests
 * that assert the forwarded context must therefore expect the TRUSTED shape,
 * not the raw context they constructed.
 *
 * Using the real deriver (rather than loosening the assertion to
 * `expect.objectContaining`) keeps the stamp itself under test: a regression
 * that dropped or altered the derived identity still fails here.
 */
export function expectedTrustedContext(ctx: DispatchContext): DispatchContext {
  return { ...ctx, callerIdentity: deriveLocalOperatorIdentity(ctx.stateDir) };
}
