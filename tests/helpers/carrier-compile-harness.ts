/**
 * Shared compiler harness for the effect-carrier compile gates.
 *
 * Two acceptance suites spawn a real `tsc` against a materialized copy of the
 * carrier: one proves that omitting an emission declaration fails the build,
 * the other relaxes each shipped guard and proves the failure goes away. They
 * had their own copies of the binary path, the flag list, the process wrapper
 * and the materialization logic.
 *
 * Two copies of a flag list drift, and a drifted flag set means the two suites
 * measure different compilers — so a guard could hold under one and not the
 * other with nothing to say so. One copy, imported twice.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The carrier under test, as it lives in the source tree. */
export const CARRIER_PATH = path.join(here, '../../src/dispatch/core/effect-carrier.ts');

/**
 * Resolved rather than path-joined.
 *
 * `node_modules` is not necessarily under the package root: a git worktree
 * resolves its dependencies from the parent checkout by walking up, so a
 * hardcoded `<root>/node_modules/...` is absent exactly when a suite runs in
 * one. `require.resolve` follows the same walk Node does.
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
 * Where the carrier's compile-time proofs begin.
 *
 * The EARLIER of the two proof blocks, deliberately, and one constant rather
 * than one per suite. The module carries two blocks — the original capability
 * proofs and the emission-declaration claims appended after them — and a
 * relaxed copy that keeps either one still asserts a property the relaxation
 * removes. The copy then fails for the right reason, which reads exactly like
 * the guard holding.
 *
 * Truncating more than a given relaxation strictly needs is safe: the fixtures
 * fail on the carrier's TYPES, not on its proofs, so removing proofs never
 * makes a fixture compile on its own.
 */
export const PROOF_BLOCK_MARKER = '// ─── Compile-time proofs';

export interface CompileResult {
  readonly accepted: boolean;
  readonly output: string;
}

/** Spawn `tsc` over `files` in `dir`, capturing both streams on rejection. */
export function compile(dir: string, files: readonly string[]): CompileResult {
  try {
    const output = execFileSync(process.execPath, [TSC_BIN, ...TSC_FLAGS, ...files], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { accepted: true, output };
  } catch (err: unknown) {
    const streams: string[] = [];
    if (typeof err === 'object' && err !== null) {
      for (const key of ['stdout', 'stderr']) {
        const value: unknown = Reflect.get(err, key);
        if (typeof value === 'string') streams.push(value);
        else if (value instanceof Uint8Array) streams.push(Buffer.from(value).toString('utf8'));
      }
    }
    return { accepted: false, output: streams.join('') };
  }
}

/**
 * One relaxation: the text it replaces and what it becomes.
 *
 * Applied only after the target is confirmed to occur EXACTLY once — see
 * {@link materializeCarrier}.
 */
export interface Relaxation {
  readonly find: string;
  readonly replace: string;
}

/**
 * Write a standalone copy of the carrier into `dir`, with `relaxations` applied.
 *
 * Tractable because the carrier's imports are rewritten onto local stubs.
 * The event-name stub widens `EventType` to `string`, which is sound for
 * these fixtures: they are about whether a field may be omitted or a brand
 * forged, never about whether an event name is registered. The replay and
 * contract stubs are similarly wide — the probes do not exercise those
 * types as subjects.
 *
 * Copying is also what keeps every probe off the live tree. A probe that edited
 * `src/` could not restore cleanly across a thrown assertion, a timeout or a
 * worker crash, and the residue would redden unrelated gates.
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
    // Presence is not enough — the target must be UNIQUE. `String.replace` with
    // a string edits the first match, so a `find` that occurs twice silently
    // relaxes the wrong site and the probe then reports that the guard held.
    // This harness caught exactly that: the capability check is spelled
    // identically in `recordEmissions` and in `runEffect`.
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
