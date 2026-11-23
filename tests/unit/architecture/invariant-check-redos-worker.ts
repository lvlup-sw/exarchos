/**
 * Runs one check-mode invariant through `dispatch` of `check_invariant_conformance`.
 *
 * The first catalog pattern is a literal token, so a finding proves the gate loaded the catalog
 * and matched the diff. The second pattern is a nested quantifier anchored at the end. The diff
 * holds a long run of the quantified character that does not satisfy the pattern. The parent
 * process kills this process if that match does not return.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { deriveMcpCallerIdentity } from '../../../src/dispatch/caller-identity.js';
import { dispatch } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import { createInMemoryResolver } from '../../../src/workflow/capabilities/resolver.js';
import {
  seedActivePhaseAttempt,
  seedGateEvidence,
} from '../../../tools/test-helpers/trusted-context.js';

const repoRoot = process.argv[2];
const stateDir = process.argv[3];
const kind = process.argv[4] as 'grep' | 'structural' | 'heuristic' | 'negated' | undefined;

const STREAM = 'wf-invariant-redos';
const ENTRY_ID = 'team-bound';
const NEEDLE = 'NEEDLE_TOKEN';
const EXPLODING_PATTERN = '(a+)+$';
const EXPLODING_RUN = 36;

const CAPABILITIES = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'isolation:worktree',
  'mcp:exarchos',
  'admission:issue-gate-evidence',
];

/** Writes the review checkout: config, and one user catalog whose check tree uses `pattern`. */
function writeCatalog(pattern: string): void {
  const catalogDir = path.join(repoRoot!, '.exarchos');
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(
    path.join(repoRoot!, '.exarchos.yml'),
    [
      'invariants:',
      '  catalogs:',
      '    - path: .exarchos/user-invariants.md',
      '      tier: user',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(catalogDir, 'user-invariants.md'),
    catalogDocument(pattern),
    'utf8',
  );
}

/**
 * One check-mode entry. The tree shape depends on the leaf kind so each evaluator arm runs.
 * `grep` is the direct leaf the catalog schema describes. `structural` sits under `all-of` and
 * `scope`. `heuristic` sits under `any-of`. Each arm reaches the shared matcher.
 */
function catalogDocument(pattern: string): string {
  const leafKind = kind === 'negated' ? 'grep' : kind;
  const fields = [
    `kind: ${leafKind}`,
    `pattern: '${pattern}'`,
    'fileGlob: "**"',
    ...(leafKind === 'grep' ? [] : ['threshold: 0']),
  ];
  return [
    '---',
    'schema-version: 3',
    'invariants:',
    `  - id: ${ENTRY_ID}`,
    '    dimension: lint',
    '    axis: substrate',
    '    cost-of-load: always-load',
    '    applies-to:',
    '      - "**"',
    '    summary: A mechanical check over the diff.',
    '    references: []',
    '    phase-affinity:',
    '      - review',
    '    workflow-affinity:',
    '      - feature',
    '    enforcement:',
    '      mode: check',
    '      check:',
    renderCheck(fields),
    '---',
    '',
  ].join('\n');
}

/**
 * Indents a leaf under the combinator that selects this kind's evaluator arm.
 * `negated` places the leaf under `not`, which still runs the matcher before it inverts the result.
 */
function renderCheck(fields: readonly string[]): string {
  if (kind === 'negated') {
    return ['        not:', ...fields.map((field) => `          ${field}`)].join('\n');
  }
  if (kind === 'structural') {
    return [
      '        all-of:',
      '          - scope:',
      '              fileGlob: "**"',
      '            node:',
      ...fields.map((field) => `              ${field}`),
    ].join('\n');
  }
  if (kind === 'heuristic') {
    const [first, ...rest] = fields;
    return [
      '        any-of:',
      `          - ${first}`,
      ...rest.map((field) => `            ${field}`),
    ].join('\n');
  }
  return fields.map((field) => `        ${field}`).join('\n');
}

/** A one-file unified diff. `added` is the single added line, without the diff prefix. */
function unifiedDiff(added: string): string {
  return [
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1 +1 @@',
    `+${added}`,
    '',
  ].join('\n');
}

interface GateData {
  readonly findings?: readonly { readonly source?: string }[];
}

/** Dispatches the gate the review runbook dispatches, against this checkout and diff. */
async function runGate(store: EventStore, diff: string): Promise<{
  readonly success: boolean;
  readonly errorCode?: string;
  readonly sources: readonly string[];
  readonly message: string | undefined;
  readonly raw: unknown;
}> {
  const result = await dispatch(
    'exarchos_orchestrate',
    {
      action: 'check_invariant_conformance',
      featureId: STREAM,
      phase: 'review',
      workflowType: 'feature',
      repoRoot,
      diff,
    },
    {
      stateDir: stateDir!,
      eventStore: store,
      enableTelemetry: false,
      callerIdentity: deriveMcpCallerIdentity({ sessionId: 'invariant-redos' }),
      capabilityResolver: createInMemoryResolver(CAPABILITIES),
    },
  );
  const data = result.data as GateData | undefined;
  return {
    success: result.success,
    ...(result.error?.code !== undefined ? { errorCode: result.error.code } : {}),
    sources: (data?.findings ?? []).map((finding) => finding.source ?? ''),
    message: result.error?.message,
    raw: result,
  };
}

/** Reports a marker with a trailing newline on an unbuffered descriptor. */
function marker(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  if (
    repoRoot === undefined ||
    stateDir === undefined ||
    (kind !== 'grep' && kind !== 'structural' && kind !== 'heuristic' && kind !== 'negated')
  ) {
    throw new Error('usage: invariant-check-redos-worker.ts <repoRoot> <stateDir> <grep|structural|heuristic|negated>');
  }
  const store = new EventStore(stateDir);
  await store.initialize();
  const phaseAttemptId = await seedActivePhaseAttempt(store, STREAM, { phase: 'review' });
  await seedGateEvidence(store, {
    streamId: STREAM,
    requirementId: 'review',
    phaseAttemptId,
  });

  const safePattern = kind === 'negated' ? 'NEEDLE_ABSENT' : NEEDLE;
  const safeLine = kind === 'negated' ? 'harmless line' : NEEDLE;
  writeCatalog(safePattern);
  const safe = await runGate(store, unifiedDiff(safeLine));
  if (!safe.success || !safe.sources.some((source) => source === `invariant:${ENTRY_ID}`)) {
    marker(`SAFE_MISS ${JSON.stringify({ success: safe.success, errorCode: safe.errorCode, message: safe.message, sources: safe.sources })}`);
    store.close();
    process.exit(2);
  }
  marker('SAFE_OK');

  writeCatalog(EXPLODING_PATTERN);
  marker('EVIL_START');
  const evil = await runGate(store, unifiedDiff(`${'a'.repeat(EXPLODING_RUN)}!`));
  marker(`RETURNED ${JSON.stringify({ success: evil.success, errorCode: evil.errorCode, sources: evil.sources })}`);
  store.close();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
