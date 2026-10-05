/**
 * The shared compiler harness for the effect-carrier compile gates.
 *
 * Two acceptance suites run a real `tsc` on a materialized copy of the carrier. One proves
 * that a missing emission declaration fails the build. The other relaxes each shipped guard
 * and proves that the failure goes away.
 *
 * Both suites import one binary path, one flag list, one process wrapper and one
 * materialization function. Two flag lists can drift, and then the suites measure different
 * compilers with no signal.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { execFileAsync, SpawnFailure } from '../../tools/test-helpers/spawn.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The carrier under test, as it lives in the source tree. */
export const CARRIER_PATH = path.join(here, '../../src/dispatch/core/effect-carrier.ts');

/**
 * The path comes from `require.resolve`, not from a join with the package root. A git
 * worktree can resolve its dependencies from the parent checkout, so
 * `<root>/node_modules/...` can be absent there. `require.resolve` does the same upward
 * walk as Node.
 */
export const TSC_BIN = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/** The one flag list. Both suites compile under identical settings or neither does. */
export const TSC_FLAGS: readonly string[] = [
  '--noEmit',
  '--strict',
  '--exactOptionalPropertyTypes',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
  '--target',
  'ES2022',
];

/**
 * The start of the compile-time proofs of the carrier. A relaxed copy ends here.
 *
 * The marker is at the earlier of the two proof blocks: the capability proofs, then the
 * emission-declaration claims. A relaxed copy that keeps a block still asserts a property
 * that the relaxation removes. Then the copy fails, and that failure looks like a guard
 * that holds.
 *
 * The cut can remove more than a relaxation needs. The fixtures fail on the types of the
 * carrier, not on its proofs, so the cut never makes a fixture compile.
 */
export const PROOF_BLOCK_MARKER = 'type Expect<T extends true> = T;';

export interface CompileResult {
  readonly accepted: boolean;
  readonly output: string;
}

/** Spawn `tsc` over `files` in `dir`, capturing both streams on rejection. */
export async function compile(dir: string, files: readonly string[]): Promise<CompileResult> {
  try {
    const output = await execFileAsync(process.execPath, [TSC_BIN, ...TSC_FLAGS, ...files], {
      cwd: dir,
    });
    return { accepted: true, output };
  } catch (err: unknown) {
    return { accepted: false, output: err instanceof SpawnFailure ? err.stdout + err.stderr : '' };
  }
}

/**
 * One relaxation: the text to find and its replacement. {@link materializeCarrier} applies
 * it only when `find` occurs exactly once.
 */
export interface Relaxation {
  readonly find: string;
  readonly replace: string;
}

/**
 * Writes a standalone copy of the carrier into `dir`, with `relaxations` applied.
 *
 * The imports of the copy point at local stubs. The event-name stub widens `EventType` to
 * `string`. That is sound, because the fixtures test an omitted field or a forged brand,
 * not a registered event name. The replay and contract stubs are also wide.
 *
 * The copy keeps each probe off the live tree. A probe that edits `src/` cannot restore it
 * after a thrown assertion, a timeout or a worker crash.
 *
 * Each `find` must occur exactly once. `String.replace` edits the first match, so a `find`
 * with two matches relaxes the wrong site, and the probe reports that the guard held.
 */
export function materializeCarrier(dir: string, relaxations: readonly Relaxation[]): void {
  fs.writeFileSync(
    path.join(dir, 'schemas.ts'),
    [
      'export type EventType = string;',
      'export function isBuiltInEventType(name: string): name is EventType {',
      '  return typeof name === "string" && name.length > 0;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'request-context.ts'),
    [
      'export type AuthenticatedRequestContext = { readonly subjectId: string };',
      'export interface ReplayIdentity {',
      '  readonly idempotencyKey: string;',
      '  readonly subjectId: string;',
      '  readonly requestDigest: string;',
      '}',
      'export function deriveReplayIdentity(',
      '  ctx: AuthenticatedRequestContext,',
      '  idempotencyKey: string,',
      '  _payload: unknown,',
      '): ReplayIdentity {',
      '  return { idempotencyKey, subjectId: ctx.subjectId, requestDigest: "probe" };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'action-contract.ts'),
    [
      "export type ReplayPolicy = { readonly kind: 'safe-repeat' | 'claim-required' | 'reject-replay' };",
      'export type ActionEmission = {',
      '  readonly event: string;',
      "  readonly condition: 'always' | 'conditional';",
      '  readonly owner: string;',
      "  readonly role: 'primary' | 'audit';",
      '  readonly description?: string;',
      '};',
      'export type ActionContract = {',
      '  readonly replay: ReplayPolicy;',
      '  readonly emissions:',
      "    | { readonly kind: 'none'; readonly because: string }",
      "    | { readonly kind: 'declared'; readonly values: readonly ActionEmission[] };",
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  let source = fs.readFileSync(CARRIER_PATH, 'utf8');
  source = source.replace("from '../../events/schemas.js'", "from './schemas.js'");
  source = source.replace("from '../../contract/request-context.js'", "from './request-context.js'");
  source = source.replace("from '../../registry/action-contract.js'", "from './action-contract.js'");

  if (relaxations.length > 0) {
    const at = source.indexOf(PROOF_BLOCK_MARKER);
    if (at === -1) {
      throw new Error(
        `the proof block marker ${JSON.stringify(PROOF_BLOCK_MARKER)} is gone from the carrier. ` +
          'A relaxed copy that still asserts what the relaxation removes fails for the right ' +
          'reason, which is indistinguishable from the guard holding.',
      );
    }
    source = source.slice(0, at);
  }

  for (const { find, replace } of relaxations) {
    const occurrences = source.split(find).length - 1;
    if (occurrences === 0) {
      throw new Error(
        `probe target not found in the carrier: ${JSON.stringify(find)}. ` +
          'The guard may have been reshaped; a probe that cannot find what it relaxes proves nothing.',
      );
    }
    if (occurrences > 1) {
      throw new Error(
        `probe target is AMBIGUOUS (${occurrences} matches): ${JSON.stringify(find)}. ` +
          'Relaxing the first match would edit a site the probe is not asserting about.',
      );
    }
    source = source.replace(find, replace);
  }

  fs.writeFileSync(path.join(dir, 'effect-carrier.ts'), source, 'utf8');
}
