// ─── Exp 1: Binary-Driven Before/After Delegation Diff (#1670, DR-1/DR-2/DR-7) ─
//
// PR #1669 fixed #1636 (per-task risk-tier/boundary stamps now thread end-to-end
// into `prepare_delegation`). The prior benchmark (`plan-format-corpus.ts`) only
// MODELED that by calling the pure `classifyTask` function in-process — it never
// crossed the binary boundary, so it could not prove the FIX shipped in a real
// artifact. That is the exact #1669 sin (a pure-function result mislabeled as
// measured).
//
// This driver replaces the modeled measurement with a MECHANICAL one. It drives
// `prepare_delegation` THROUGH each built binary's real MCP tool surface (a
// spawned `<binary> mcp` stdio server — never the pure TS function), over the
// stamped `docs/specs/` corpus, and diffs the returned `taskClassifications`.
//
// Arm asymmetry (verified empirically — the pre-fix binaries have NO `planPath`
// support; it was added by #1669):
//   - before-arm: invoke a pre-fix binary with `tasks:[{id,title}]` and NO
//     `planPath` → heuristic classification (every bare task → medium /
//     no-boundary / [check_static_analysis, check_test_adequacy]).
//   - after-arm: invoke a fixed binary WITH `planPath` (the corpus spec) so the
//     stamp-lift path runs → the plan's authored high/low/boundary tiers +
//     check_integration_suite on high tasks.
//
// Fail-honest (DR-7): a binary that will not dispatch a spec records a `blocked`
// result — never a substituted / modeled number.
//
// This module is split so the PURE diff core (`diffClassifications` + helpers)
// is independently testable without spawning anything; the MCP-spawning halves
// are the impure orchestration.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseTaskStamps } from '../../orchestrate/parse-task-stamps.js';
import { stampProvenance, type ProvenanceStamped } from '../provenance.js';

// ─── Pure diff core (the graded / kill-probe surface) ────────────────────────

/** The measured shape captured from one task's `taskClassifications` entry. */
export interface ClassificationSnapshot {
  readonly taskId: string;
  /** `riskTier` from the classification, or `null` if the binary omitted it. */
  readonly riskTier: string | null;
  /** `boundaryTouching`, or `null` if omitted. */
  readonly boundaryTouching: boolean | null;
  /** `verificationSequence` gate names, in order (empty if omitted). */
  readonly verificationSequence: readonly string[];
}

/** One task's before→after delta. Symmetric + present for every task in either arm. */
export interface TaskDiff {
  readonly taskId: string;
  readonly beforeTier: string | null;
  readonly afterTier: string | null;
  readonly beforeBoundary: boolean | null;
  readonly afterBoundary: boolean | null;
  readonly beforeSteps: number;
  readonly afterSteps: number;
  readonly beforeSequence: readonly string[];
  readonly afterSequence: readonly string[];
  /** True when tier, boundary, or the gate sequence differs between the arms. */
  readonly changed: boolean;
}

/** Order-sensitive gate-sequence equality. */
export function sequencesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Whether two snapshots for the same task represent a changed classification.
 * A missing snapshot on either side is always a change (presence differs). Pure.
 */
export function snapshotChanged(
  before: ClassificationSnapshot | undefined,
  after: ClassificationSnapshot | undefined,
): boolean {
  if (!before || !after) return before !== after; // one present, one absent → changed
  return (
    before.riskTier !== after.riskTier ||
    before.boundaryTouching !== after.boundaryTouching ||
    !sequencesEqual(before.verificationSequence, after.verificationSequence)
  );
}

function tierOf(s: ClassificationSnapshot | undefined): string | null {
  return s ? s.riskTier : null;
}
function boundaryOf(s: ClassificationSnapshot | undefined): boolean | null {
  return s ? s.boundaryTouching : null;
}
function seqOf(s: ClassificationSnapshot | undefined): readonly string[] {
  return s ? s.verificationSequence : [];
}

/**
 * Diff two classification sets into a per-task delta. The result is:
 *   - COMPLETE — exactly one {@link TaskDiff} per taskId present in EITHER arm,
 *     sorted by taskId (deterministic).
 *   - SYMMETRIC — `diffClassifications(a, b)` and `diffClassifications(b, a)`
 *     cover the same taskId set, agree on every `changed` flag, and mirror the
 *     before/after fields (before(a,b) === after(b,a)).
 * Pure: no I/O.
 */
export function diffClassifications(
  before: readonly ClassificationSnapshot[],
  after: readonly ClassificationSnapshot[],
): TaskDiff[] {
  const beforeById = new Map(before.map((s) => [s.taskId, s]));
  const afterById = new Map(after.map((s) => [s.taskId, s]));
  const taskIds = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();

  return taskIds.map((taskId) => {
    const b = beforeById.get(taskId);
    const a = afterById.get(taskId);
    return {
      taskId,
      beforeTier: tierOf(b),
      afterTier: tierOf(a),
      beforeBoundary: boundaryOf(b),
      afterBoundary: boundaryOf(a),
      beforeSteps: seqOf(b).length,
      afterSteps: seqOf(a).length,
      beforeSequence: seqOf(b),
      afterSequence: seqOf(a),
      changed: snapshotChanged(b, a),
    };
  });
}

/** Count of tasks whose classification changed across a diff. */
export function countChanged(diffs: readonly TaskDiff[]): number {
  return diffs.filter((d) => d.changed).length;
}

// ─── Corpus loading (harness setup — NOT the measured surface) ────────────────

/** A corpus spec reduced to the `{id,title}` task inputs the arms are driven with. */
export interface CorpusSpecTasks {
  /** Basename of the spec file, e.g. `2026-07-09-...md`. */
  readonly specId: string;
  /** Absolute path — used as `planPath` for the after-arm. */
  readonly specPath: string;
  /** `{id,title}` for every task header the production stamp parser found. */
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

/**
 * Load every spec under `specsDir` that carries at least one stamped task,
 * reducing each to its `{id,title}` task list via the PRODUCTION stamp parser
 * (`parseTaskStamps`) so the ids the arms pass match the ids the after-binary
 * lifts stamps against. Harness setup only — the classification itself happens
 * inside the binary.
 */
export function loadCorpusTasks(specsDir: string): CorpusSpecTasks[] {
  const specs: CorpusSpecTasks[] = [];
  for (const file of fs.readdirSync(specsDir).filter((f) => f.endsWith('.md')).sort()) {
    const specPath = path.join(specsDir, file);
    const parsed = parseTaskStamps(fs.readFileSync(specPath, 'utf-8'));
    if (!parsed.some((t) => t.riskTier !== undefined)) continue; // unstamped doc — skip
    specs.push({
      specId: file,
      specPath,
      tasks: parsed.map((t) => ({ id: t.id, title: t.title })),
    });
  }
  return specs;
}

// ─── Binary refs + provenance (task 003) ─────────────────────────────────────

export type BinaryArm = 'before' | 'after';

/** Everything needed to drive + provenance-stamp one reference binary. */
export interface BinaryRef {
  readonly label: string;
  readonly arm: BinaryArm;
  /** `--version` output cross-checked against the built binary. */
  readonly binaryTag: string;
  /** Full git SHA the binary was built from. */
  readonly gitSha: string;
  /** Deterministic build date = the commit's ISO date (no wall-clock — reproducible). */
  readonly buildDate: string;
  readonly has1659: boolean;
  readonly has1669: boolean;
  /** Absolute path to the built `dist/bin/exarchos-linux-x64`. */
  readonly binaryPath: string;
}

/** A single confounding commit co-resident in a measurement window. */
export interface ConfoundCommit {
  readonly sha: string;
  readonly ref: string;
  readonly role: string;
}

/** Binary ref metadata sans the (environment-specific) built-binary path. */
export type BinaryRefMeta = Omit<BinaryRef, 'binaryPath'>;

/**
 * The four Exp-1 reference binaries (task 003). SHAs/dates are the refs' own git
 * values (deterministic — the commit's committer date, no wall-clock). The
 * `causal` pair isolates #1669 alone; the `released` pair is CONFOUNDED (it also
 * spans #1659, `585c154c`, a dispatch-guard change touching the measured path).
 */
export const EXP1_BINARY_REFS: readonly BinaryRefMeta[] = [
  {
    label: 'causal-before',
    arm: 'before',
    binaryTag: 'v2.12.0-preview.1',
    gitSha: '585c154cb978013b82264b8502d9226bb92ed49c', // a240b4d8^ (#1659, NOT #1669)
    buildDate: '2026-07-09T18:50:14-07:00',
    has1659: true,
    has1669: false,
  },
  {
    label: 'causal-after',
    arm: 'after',
    binaryTag: 'v2.12.0-preview.1',
    gitSha: 'a240b4d84c932fcbe1fa8519fb8efbb04a2fa4d8', // #1669 merge (has #1659 AND #1669)
    buildDate: '2026-07-09T21:14:09-07:00',
    has1659: true,
    has1669: true,
  },
  {
    label: 'released-before',
    arm: 'before',
    binaryTag: 'v2.12.0-preview.1',
    gitSha: 'f70b1e82c2a6f07966d4e4a35df821460364b79b', // tag v2.12.0-preview.1 (NEITHER)
    buildDate: '2026-07-06T06:29:03+00:00',
    has1659: false,
    has1669: false,
  },
  {
    label: 'released-after',
    arm: 'after',
    binaryTag: 'v2.12.0-preview.2',
    gitSha: '5501cce6a915052cad858cb5acd4a890b26884ab', // tag v2.12.0-preview.2 (BOTH)
    buildDate: '2026-07-09T22:59:39-07:00',
    has1659: true,
    has1669: true,
  },
];

/** The before→after pairs, by binary label. */
export const EXP1_PAIRS: ReadonlyArray<{ readonly pair: string; readonly before: string; readonly after: string }> = [
  { pair: 'causal', before: 'causal-before', after: 'causal-after' },
  { pair: 'released', before: 'released-before', after: 'released-after' },
];

/**
 * Commits co-resident in the released window `v2.12.0-preview.1..v2.12.0-preview.2`.
 * #1659 is the documented CONFOUND — the released pair cannot attribute its delta
 * to #1669 alone; the causal pair (a240b4d8^ → a240b4d8) can.
 */
export const RELEASED_WINDOW_CONFOUNDS: readonly ConfoundCommit[] = [
  {
    sha: 'a240b4d84c932fcbe1fa8519fb8efbb04a2fa4d8',
    ref: '#1669',
    role: 'the fix under test — threads planner risk/boundary stamps end-to-end (planPath stamp-lift)',
  },
  {
    sha: '585c154cb978013b82264b8502d9226bb92ed49c',
    ref: '#1659',
    role: 'CONFOUND — dispatch-guard + pipeline-view change touching the measured prepare_delegation path; co-resident in the released pair',
  },
  {
    sha: '5501cce6a915052cad858cb5acd4a890b26884ab',
    ref: 'chore',
    role: 'version bump to 2.12.0-preview.2 (no behavioral change)',
  },
];

/** Resolve one ref's built-binary path under a binaries directory. */
export function resolveBinaryPath(binariesDir: string, label: string): string {
  return path.join(binariesDir, label, 'dist/bin/exarchos-linux-x64');
}

/** The role string for a ref, used in the provenance artifact. */
function roleFor(ref: BinaryRefMeta): string {
  return ref.arm === 'before'
    ? 'before-arm (no planPath — heuristic classification)'
    : 'after-arm (planPath — stamp-lift classification)';
}

/**
 * Build the full task-003 provenance artifact: every binary stamped through
 * `stampProvenance`, plus the enumerated released-window confound list and the
 * model-free note. Pure — takes the refs/confounds as input, no I/O.
 */
export function buildProvenanceArtifact(
  refs: readonly BinaryRefMeta[] = EXP1_BINARY_REFS,
  confounds: readonly ConfoundCommit[] = RELEASED_WINDOW_CONFOUNDS,
): {
  readonly experiment: string;
  readonly note: string;
  readonly modelNote: string;
  readonly causalPairIsolates: string;
  readonly binaries: ReadonlyArray<ProvenanceStamped<BinaryProvenanceRecord>>;
  readonly releasedWindow: { readonly range: string; readonly confounds: readonly ConfoundCommit[] };
} {
  return {
    experiment: 'exp1-binaries',
    note:
      'Provenance for the four reference binaries driven in Exp 1 (#1670, tasks 003+004). ' +
      'Each was built with `bun run scripts/build-binary.ts --target linux-x64` in a throwaway ' +
      'worktree and its `--version` cross-checked (recorded as binaryTag). SHAs/dates are the ' +
      'commit values (deterministic, no wall-clock).',
    modelNote:
      'Exp 1 is MODEL-FREE: prepare_delegation classification is deterministic (no LLM). ' +
      "modelIds carries the sentinel ['none'] only to satisfy the provenance helper's non-empty invariant.",
    causalPairIsolates:
      'causal pair (a240b4d8^=585c154c → a240b4d8) isolates #1669 alone; released pair ' +
      '(v2.12.0-preview.1 → v2.12.0-preview.2) is confounded by co-resident #1659 (585c154c).',
    binaries: refs.map((r) => stampBinaryProvenance({ ...r, binaryPath: '' }, roleFor(r))),
    releasedWindow: { range: 'v2.12.0-preview.1..v2.12.0-preview.2', confounds },
  };
}

/**
 * Exp1 is MODEL-FREE: `prepare_delegation`'s classification is deterministic
 * (no LLM in the path). The provenance helper requires a non-empty `modelIds`,
 * so we carry the self-documenting sentinel `['none']` and explain it in the
 * artifact's top-level note. The reproducibility pins that matter here are
 * `binaryTag` / `gitSha` / `date`.
 */
export const EXP1_MODEL_IDS: readonly string[] = ['none'];

/** A provenance-stamped binary record for the task-003 artifact. */
export interface BinaryProvenanceRecord {
  readonly label: string;
  readonly arm: BinaryArm;
  readonly role: string;
  readonly versionReported: string;
  readonly has1659: boolean;
  readonly has1669: boolean;
  readonly buildStatus: 'success' | 'blocked';
  readonly source: 'measured';
}

/**
 * Stamp a binary ref through the task-001 provenance helper (`stampProvenance`).
 * `date`/`gitSha`/`binaryTag` are the ref's own values (no ambient clock). Pure.
 */
export function stampBinaryProvenance(
  ref: BinaryRef,
  role: string,
): ProvenanceStamped<BinaryProvenanceRecord> {
  return stampProvenance(
    {
      label: ref.label,
      arm: ref.arm,
      role,
      versionReported: ref.binaryTag,
      has1659: ref.has1659,
      has1669: ref.has1669,
      buildStatus: 'success' as const,
      source: 'measured' as const,
    },
    {
      binaryTag: ref.binaryTag,
      gitSha: ref.gitSha,
      modelIds: EXP1_MODEL_IDS,
      date: ref.buildDate,
    },
  );
}

// ─── MCP invocation through the real binary (impure) ─────────────────────────

/**
 * Provision a git repo the spawned MCP server can pass its dispatch guards from:
 * a `main`-descended feature branch (ancestry guard) + `.claude/settings.json`
 * pinning `worktree.baseRef: head` (#1659 native-isolation baseRef guard). Idempotent.
 */
export function setupServerRoot(dir: string): void {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ worktree: { baseRef: 'head' } }) + '\n',
  );
  const git = (args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  };
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'exp1@example.com']);
    git(['config', 'user.name', 'exp1']);
    fs.writeFileSync(path.join(dir, 'README.md'), 'exp1 server root\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'baseline']);
    git(['checkout', '-qb', 'feature/exp1']);
  }
}

/** Result of driving one spec through one binary. */
export type SpecRunResult =
  | { readonly ok: true; readonly classifications: ClassificationSnapshot[] }
  | { readonly ok: false; readonly blocked: { readonly reason: string; readonly detail: string } };

/**
 * Runtime schema for the MCP tool envelope. This is the boundary where the driver
 * crosses into the REAL binary (the whole point of Exp 1), so the payload is
 * validated with Zod rather than cast — a malformed or differently-shaped response
 * from the binary is caught here, not silently propagated as wrong types into the
 * diff/CSV.
 */
const EnvelopeSchema = z.object({
  success: z.boolean().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  data: z
    .object({
      ready: z.boolean().optional(),
      blockers: z.array(z.unknown()).optional(),
      taskClassifications: z
        .array(
          z.object({
            taskId: z.string(),
            riskTier: z.string().optional(),
            boundaryTouching: z.boolean().optional(),
            verificationSequence: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
type EnvelopeShape = z.infer<typeof EnvelopeSchema>;

/** Parse + validate the tool envelope. Fail-honest: a non-JSON or off-schema
 *  payload returns a reason string (caller records a `blocked` result) rather than
 *  throwing and crashing the whole run. */
function parseEnvelope(
  res: { content?: Array<{ type: string; text?: string }> },
): { ok: true; env: EnvelopeShape } | { ok: false; reason: string } {
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '{}';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `malformed JSON from binary: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = EnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `envelope failed schema: ${parsed.error.issues[0]?.message ?? 'invalid shape'}` };
  }
  return { ok: true, env: parsed.data };
}

function toSnapshots(env: EnvelopeShape): ClassificationSnapshot[] {
  return (env.data?.taskClassifications ?? []).map((c) => ({
    taskId: c.taskId,
    riskTier: c.riskTier ?? null,
    boundaryTouching: c.boundaryTouching ?? null,
    verificationSequence: c.verificationSequence ?? [],
  }));
}

/**
 * Spawn `<binary> mcp`, and for each corpus spec seed a ready delegation stream
 * (plan-review transition + plan artifact + one `task.assigned` per task) then
 * call `exarchos_orchestrate prepare_delegation` — WITH `planPath` for the
 * after-arm, WITHOUT for the before-arm. Returns per-spec snapshots (or a
 * fail-honest `blocked` result when a spec will not dispatch).
 *
 * One server process + one fresh event store (`WORKFLOW_STATE_DIR`) per binary;
 * each spec is an isolated `featureId` stream.
 */
export async function runArmOverCorpus(
  ref: BinaryRef,
  corpus: readonly CorpusSpecTasks[],
  serverRoot: string,
): Promise<Map<string, SpecRunResult>> {
  const stateDir = fs.mkdtempSync(path.join(path.dirname(serverRoot), `exp1-state-${ref.label}-`));
  const transport = new StdioClientTransport({
    command: ref.binaryPath,
    args: ['mcp'],
    cwd: serverRoot,
    env: Object.fromEntries(
      Object.entries({ ...process.env, WORKFLOW_STATE_DIR: stateDir }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  });
  const client = new Client({ name: 'exp1-driver', version: '0.0.0' }, { capabilities: {} });

  const results = new Map<string, SpecRunResult>();
  try {
    // Inside the try so a handshake failure is still torn down (client.close +
    // stateDir removal) rather than orphaning the spawned `mcp` process.
    await client.connect(transport);
    for (const spec of corpus) {
      // The event store requires streamId to match /^[a-z0-9-]+$/ — lowercase,
      // fold every other character (dots, underscores, uppercase) to a hyphen,
      // and collapse/trim runs so the featureId is always a valid stream.
      const featureId = `exp1-${ref.label}-${spec.specId}`
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      const append = (event: unknown): Promise<unknown> =>
        client.callTool({
          name: 'exarchos_event',
          arguments: { action: 'append', stream: featureId, event },
        });

      await append({
        type: 'workflow.transition',
        data: { from: 'plan', to: 'plan-review', trigger: 'manual', featureId },
      });
      await append({ type: 'state.patched', data: { patch: { 'artifacts.plan': spec.specPath } } });
      for (const t of spec.tasks) {
        await append({ type: 'task.assigned', data: { taskId: t.id, title: t.title } });
      }

      const args: Record<string, unknown> = {
        action: 'prepare_delegation',
        featureId,
        nativeIsolation: true,
        tasks: spec.tasks.map((t) => ({ id: t.id, title: t.title })),
      };
      if (ref.arm === 'after') args['planPath'] = spec.specPath;

      const res = await client.callTool({ name: 'exarchos_orchestrate', arguments: args });
      const parsed = parseEnvelope(res as { content?: Array<{ type: string; text?: string }> });
      if (!parsed.ok) {
        results.set(spec.specId, {
          ok: false,
          blocked: { reason: 'ENVELOPE_PARSE_FAILED', detail: parsed.reason },
        });
        continue;
      }
      const env = parsed.env;

      if (env.success !== true) {
        results.set(spec.specId, {
          ok: false,
          blocked: {
            reason: env.error?.code ?? 'DISPATCH_FAILED',
            detail: env.error?.message ?? 'prepare_delegation returned success=false',
          },
        });
        continue;
      }
      if (!env.data?.taskClassifications) {
        results.set(spec.specId, {
          ok: false,
          blocked: {
            reason: 'NO_CLASSIFICATIONS',
            detail: `ready=${env.data?.ready}; blockers=${JSON.stringify(env.data?.blockers ?? [])}`,
          },
        });
        continue;
      }
      results.set(spec.specId, { ok: true, classifications: toSnapshots(env) });
    }
  } finally {
    await client.close();
    // Remove the per-binary temp state dir so repeated runs (e.g. CI) don't
    // accumulate orphaned directories.
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  return results;
}

// ─── Pair diffing + CSV emission (task 004) ──────────────────────────────────

/** A per-(pair, spec, task) row for the CSV artifact. */
export interface DiffRow {
  readonly pair: string;
  readonly beforeLabel: string;
  readonly afterLabel: string;
  readonly beforeSha: string;
  readonly afterSha: string;
  readonly spec: string;
  readonly task: string;
  readonly beforeTier: string;
  readonly afterTier: string;
  readonly beforeBoundary: string;
  readonly afterBoundary: string;
  readonly beforeSteps: number;
  readonly afterSteps: number;
  readonly beforeSequence: string;
  readonly afterSequence: string;
  readonly changed: boolean;
}

function cell(value: string | null): string {
  return value === null ? 'MISSING' : value;
}

/**
 * Build CSV rows for one before→after pair. `blocked` specs on either arm emit a
 * single fail-honest row (tier/steps = `BLOCKED`) rather than a fabricated diff.
 * Traceable: every row carries both binaries' git SHAs (→ the provenance record).
 */
export function buildPairRows(
  pairName: string,
  before: BinaryRef,
  after: BinaryRef,
  beforeRuns: ReadonlyMap<string, SpecRunResult>,
  afterRuns: ReadonlyMap<string, SpecRunResult>,
  corpus: readonly CorpusSpecTasks[],
): DiffRow[] {
  const rows: DiffRow[] = [];
  const base = {
    pair: pairName,
    beforeLabel: before.label,
    afterLabel: after.label,
    beforeSha: before.gitSha,
    afterSha: after.gitSha,
  };
  for (const spec of corpus) {
    const b = beforeRuns.get(spec.specId);
    const a = afterRuns.get(spec.specId);
    if (!b?.ok || !a?.ok) {
      const detail = !b?.ok
        ? `before:${b?.ok === false ? b.blocked.reason : 'MISSING'}`
        : `after:${a?.ok === false ? a.blocked.reason : 'MISSING'}`;
      rows.push({
        ...base,
        spec: spec.specId,
        task: 'ALL',
        beforeTier: 'BLOCKED',
        afterTier: 'BLOCKED',
        beforeBoundary: 'BLOCKED',
        afterBoundary: 'BLOCKED',
        beforeSteps: -1,
        afterSteps: -1,
        beforeSequence: detail,
        afterSequence: detail,
        changed: false,
      });
      continue;
    }
    for (const d of diffClassifications(b.classifications, a.classifications)) {
      rows.push({
        ...base,
        spec: spec.specId,
        task: d.taskId,
        beforeTier: cell(d.beforeTier),
        afterTier: cell(d.afterTier),
        beforeBoundary: d.beforeBoundary === null ? 'MISSING' : String(d.beforeBoundary),
        afterBoundary: d.afterBoundary === null ? 'MISSING' : String(d.afterBoundary),
        beforeSteps: d.beforeSteps,
        afterSteps: d.afterSteps,
        beforeSequence: d.beforeSequence.join(';'),
        afterSequence: d.afterSequence.join(';'),
        changed: d.changed,
      });
    }
  }
  return rows;
}

/** Column order for the CSV artifact. */
export const CSV_COLUMNS: readonly (keyof DiffRow)[] = [
  'pair',
  'beforeLabel',
  'afterLabel',
  'beforeSha',
  'afterSha',
  'spec',
  'task',
  'beforeTier',
  'afterTier',
  'beforeBoundary',
  'afterBoundary',
  'beforeSteps',
  'afterSteps',
  'beforeSequence',
  'afterSequence',
  'changed',
];

/** Render rows to CSV text. Field values never contain commas (`;`-joined sequences). */
export function toCsv(rows: readonly DiffRow[]): string {
  const header = CSV_COLUMNS.join(',');
  const body = rows.map((r) => CSV_COLUMNS.map((c) => String(r[c])).join(','));
  return [header, ...body].join('\n') + '\n';
}

// ─── Reproducible end-to-end run (task 003+004) ──────────────────────────────

/** The changed-task tally for one before→after pair over the dispatched corpus. */
export interface PairSummary {
  readonly pair: string;
  readonly changed: number;
  readonly total: number;
  readonly blockedSpecs: number;
}

/** The full Exp-1 result: provenance artifact, CSV rows, and per-pair summaries. */
export interface Exp1Result {
  readonly provenance: ReturnType<typeof buildProvenanceArtifact>;
  readonly csvRows: DiffRow[];
  readonly summaries: PairSummary[];
  readonly corpusSpecCount: number;
  readonly corpusTaskCount: number;
}

/**
 * Drive ALL four reference binaries over the corpus and assemble the committed
 * artifacts. Impure (spawns binaries, provisions a server root) but returns the
 * data rather than writing files — the caller ({@link main}) owns I/O. A binary
 * absent from `binariesDir` throws (fail-honest — never a modeled substitute).
 */
export async function runExp1(opts: {
  binariesDir: string;
  specsDir: string;
  serverRoot: string;
}): Promise<Exp1Result> {
  setupServerRoot(opts.serverRoot);
  const corpus = loadCorpusTasks(opts.specsDir);

  const withPath = (m: BinaryRefMeta): BinaryRef => ({
    ...m,
    binaryPath: resolveBinaryPath(opts.binariesDir, m.label),
  });

  const runs = new Map<string, Map<string, SpecRunResult>>();
  for (const meta of EXP1_BINARY_REFS) {
    const ref = withPath(meta);
    if (!fs.existsSync(ref.binaryPath)) {
      throw new Error(`fail-honest: binary for '${ref.label}' not found at ${ref.binaryPath}`);
    }
    runs.set(meta.label, await runArmOverCorpus(ref, corpus, opts.serverRoot));
  }

  const refByLabel = new Map(EXP1_BINARY_REFS.map((m) => [m.label, withPath(m)]));
  const csvRows: DiffRow[] = [];
  const summaries: PairSummary[] = [];
  for (const { pair, before, after } of EXP1_PAIRS) {
    const beforeRuns = runs.get(before)!;
    const afterRuns = runs.get(after)!;
    csvRows.push(
      ...buildPairRows(pair, refByLabel.get(before)!, refByLabel.get(after)!, beforeRuns, afterRuns, corpus),
    );
    let changed = 0;
    let total = 0;
    let blockedSpecs = 0;
    for (const spec of corpus) {
      const b = beforeRuns.get(spec.specId);
      const a = afterRuns.get(spec.specId);
      if (b?.ok && a?.ok) {
        const diffs = diffClassifications(b.classifications, a.classifications);
        changed += countChanged(diffs);
        total += diffs.length;
      } else {
        blockedSpecs += 1;
      }
    }
    summaries.push({ pair, changed, total, blockedSpecs });
  }

  return {
    provenance: buildProvenanceArtifact(),
    csvRows,
    summaries,
    corpusSpecCount: corpus.length,
    corpusTaskCount: corpus.reduce((n, s) => n + s.tasks.length, 0),
  };
}

/**
 * CLI entry: `tsx src/evals/benchmarks/exp1-binary-driver.ts` — regenerates the
 * committed artifacts under `docs/evals/data/2026-07-09/`. Binaries are resolved
 * from `EXP1_BINARIES_DIR` (default `/tmp/1670-exp1`), each built per task 003.
 */
export async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const outDir = path.join(repoRoot, 'docs/evals/data/2026-07-09');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exp1-run-'));
  try {
    const result = await runExp1({
      binariesDir: process.env['EXP1_BINARIES_DIR'] ?? '/tmp/1670-exp1',
      specsDir: path.join(repoRoot, 'docs/specs'),
      serverRoot: path.join(workRoot, 'serverroot'),
    });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'exp1-before-after.csv'), toCsv(result.csvRows));
    fs.writeFileSync(
      path.join(outDir, 'binaries.provenance.json'),
      JSON.stringify(result.provenance, null, 2) + '\n',
    );
    process.stdout.write(
      JSON.stringify(
        {
          corpusSpecs: result.corpusSpecCount,
          corpusTasks: result.corpusTaskCount,
          summaries: result.summaries,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

// Direct-execution guard: run `main()` only when invoked as a script (tsx),
// never when imported by vitest (argv[1] is the test runner there).
if (process.argv[1] && process.argv[1].endsWith('exp1-binary-driver.ts')) {
  await main();
}
