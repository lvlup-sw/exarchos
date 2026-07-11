// ─── Seeded-defect corpus — shared failure-tail substrate (#1675, task 003) ───
//
// The corpus #1670 never produced: inputs that *should* fail verification, with
// matched known-good controls, one class per mechanical gate. Six defect
// classes (DR-2):
//
//   test-adequacy      → check_test_adequacy    — vacuous / tautological test
//   contract-drift     → check_contract_drift   — broken seam contract
//   mock-boundary      → check_mock_boundary    — over-mocked (unowned) boundary
//   static-analysis    → check_static_analysis  — type / lint violation
//   integration-suite  → check_integration_suite— broad-blast regression
//   dropped-edge-case  → (no production gate)   — hidden-oracle only
//
// The dropped-edge-case class is a DECLARED DEVIATION from #1675's six-row gate
// table: no mechanical gate can catch a silently-dropped edge case, so it is
// detected by an eval-side HIDDEN ORACLE ({@link runDroppedEdgeOracle}) and is
// the escaped-defect substrate for the DR-5 gate-policy replay — never a row in
// the catch-rate table. Its exclusion is documented here and in the Bundle-A
// findings doc.
//
// ── Design invariants ────────────────────────────────────────────────────────
//  • Fixtures are INERT TEMPLATE ASSETS — JSON file-maps under `fixtures/`, one
//    per class. They are NEVER compiled TypeScript (the fixtures/ dir is excluded
//    from tsconfig + eslint) so intentionally type/lint-broken defect content
//    cannot fail repo CI. Broken source exists only as string data here, and
//    becomes a real file solely inside a disposable worktree at materialize time.
//  • Loading ({@link loadSeededCorpus}) is deterministic and offline: no LLM, no
//    network, no temp dirs, no spawns — just read the JSON + derive tiers.
//  • Each fixture manifest carries `{ gate, defectMechanism, expectedVerdict,
//    riskTier, boundaryTouching }`, where the tier stamps are DERIVED by the
//    production classifier (`deriveRiskTier` / `deriveBoundaryTouching`) from the
//    fixture's real changed file paths — never hand-assigned (the anti-pinning
//    contract). The author's file-path choices steer the tiers; the multi-tier-
//    span test makes that visible rather than hiding it.
//  • ONE loader API is the single source consumed by the catch-rate driver
//    (task 004), the gate-policy replay (task 006), and the DR-7 ratchet (013).
// ────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  deriveRiskTier,
  deriveBoundaryTouching,
  type RiskTier,
} from '../../../orchestrate/prepare-delegation.js';

// ─── Gate-class taxonomy ──────────────────────────────────────────────────────

/** The six seeded-defect classes (five gate-targeting + one hidden-oracle). */
export type GateClass =
  | 'test-adequacy'
  | 'contract-drift'
  | 'mock-boundary'
  | 'static-analysis'
  | 'integration-suite'
  | 'dropped-edge-case';

/** The five mechanical gate classes, in stable table order. */
export const MECHANICAL_GATE_CLASSES: readonly GateClass[] = [
  'test-adequacy',
  'contract-drift',
  'mock-boundary',
  'static-analysis',
  'integration-suite',
];

/** Every class, mechanical gates first, dropped-edge-case last. */
export const SEEDED_GATE_CLASSES: readonly GateClass[] = [
  ...MECHANICAL_GATE_CLASSES,
  'dropped-edge-case',
];

/** The `exarchos_orchestrate` gate action each class targets (`null` = ungated). */
export const GATE_FOR_CLASS: Readonly<Record<GateClass, string | null>> = {
  'test-adequacy': 'check_test_adequacy',
  'contract-drift': 'check_contract_drift',
  'mock-boundary': 'check_mock_boundary',
  'static-analysis': 'check_static_analysis',
  'integration-suite': 'check_integration_suite',
  'dropped-edge-case': null,
};

// ─── Fixture model ────────────────────────────────────────────────────────────

/** Whether a fixture is a seeded defect or a matched known-good control. */
export type FixtureKind = 'defect' | 'control';

/**
 * The verdict a correct gate should return for a fixture:
 *   • `fail`    — a seeded defect the gate must flag (true positive).
 *   • `pass`    — a control the gate must leave clean (no false positive).
 *   • `ungated` — dropped-edge-case: NO production gate targets it; detection is
 *                 the hidden oracle's job, and it escapes every gate set.
 */
export type ExpectedVerdict = 'fail' | 'pass' | 'ungated';

/** A repo-relative path → file-content map (materialized into a worktree). */
export type FileMap = Readonly<Record<string, string>>;

/**
 * The hidden-oracle spec for a dropped-edge-case fixture. The oracle imports
 * `module`'s named `export` from the materialized HEAD tree and checks each edge
 * `case`; a mismatch means the dropped edge is present (the defect). No
 * production gate reads this — it is the eval-side grading device.
 */
export interface OracleSpec {
  /** Repo-relative ESM module in the fixture HEAD (e.g. `src/clamp.mjs`). */
  readonly module: string;
  /** The named export under test. */
  readonly export: string;
  /** Edge-case probes: call `export(...args)` and compare to `expected`. */
  readonly cases: ReadonlyArray<{ readonly args: readonly unknown[]; readonly expected: unknown }>;
}

/** The DR-2 manifest fields carried on every fixture. */
export interface FixtureManifest {
  /** The `exarchos_orchestrate` gate this class targets (`null` = ungated). */
  readonly gate: string | null;
  /** Human description of the seeded defect mechanism (or the control's shape). */
  readonly defectMechanism: string;
  /** The verdict a correct gate should return. */
  readonly expectedVerdict: ExpectedVerdict;
  /** DERIVED by `deriveRiskTier` from the changed file paths — never hand-set. */
  readonly riskTier: RiskTier;
  /** DERIVED by `deriveBoundaryTouching` from the changed file paths. */
  readonly boundaryTouching: boolean;
}

/** A fully-resolved corpus fixture returned by {@link loadSeededCorpus}. */
export interface SeededFixture {
  /** Stable id, e.g. `test-adequacy/defect-01`. */
  readonly id: string;
  /** The defect class. */
  readonly gateClass: GateClass;
  /** defect vs control. */
  readonly kind: FixtureKind;
  /** The DR-2 manifest (gate/mechanism/verdict + derived tiers). */
  readonly manifest: FixtureManifest;
  /** Files committed on `baseBranch` (the merge-base state). */
  readonly base: FileMap;
  /** Files committed on `branch` (the task-diff state the gate inspects). */
  readonly head: FileMap;
  /** Repo-relative paths that differ base→head (what a real `git diff` sees). */
  readonly changedFiles: readonly string[];
  /** The feature branch the head is committed on. */
  readonly branch: string;
  /** The base branch (always `main`). */
  readonly baseBranch: string;
  /** Present only for dropped-edge-case fixtures — the hidden-oracle spec. */
  readonly oracle?: OracleSpec;
}

// ─── Raw asset shape (the JSON on disk) ───────────────────────────────────────

interface RawFixture {
  readonly id: string;
  readonly defectMechanism: string;
  readonly base: FileMap;
  readonly head: FileMap;
  readonly oracle?: OracleSpec;
}

interface RawClassAsset {
  readonly gateClass: GateClass;
  readonly gate: string | null;
  readonly branchPrefix: string;
  readonly defects: readonly RawFixture[];
  readonly controls: readonly RawFixture[];
}

// ─── Loading ──────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, 'fixtures');

/** The per-class asset filename. */
function assetPathFor(gateClass: GateClass): string {
  return path.join(FIXTURES_DIR, `${gateClass}.json`);
}

/**
 * Compute the repo-relative paths that differ between `base` and `head` — the
 * exact set `git diff --name-only base...HEAD` would report. Added, modified,
 * and deleted paths all count. Sorted for deterministic classifier input.
 */
export function computeChangedFiles(base: FileMap, head: FileMap): string[] {
  const changed = new Set<string>();
  for (const [p, content] of Object.entries(head)) {
    if (base[p] !== content) changed.add(p);
  }
  for (const p of Object.keys(base)) {
    if (!(p in head)) changed.add(p);
  }
  return [...changed].sort();
}

/**
 * Derive the risk-tier + boundary-touching manifest stamps from a fixture's real
 * changed file paths, using the PRODUCTION classifier (`deriveRiskTier` /
 * `deriveBoundaryTouching`). This is the anti-pinning contract: the stamps are a
 * function of the file paths the author chose, never a value typed into the
 * asset. Exported so the tests can assert the derivation is not hand-forged.
 */
export function deriveManifestTiers(changedFiles: readonly string[]): {
  riskTier: RiskTier;
  boundaryTouching: boolean;
} {
  const task = { id: 'seeded-fixture', title: '', files: [...changedFiles] };
  return {
    riskTier: deriveRiskTier(task),
    boundaryTouching: deriveBoundaryTouching(task),
  };
}

function resolveFixture(
  raw: RawFixture,
  asset: RawClassAsset,
  kind: FixtureKind,
): SeededFixture {
  const changedFiles = computeChangedFiles(raw.base, raw.head);
  const { riskTier, boundaryTouching } = deriveManifestTiers(changedFiles);
  const expectedVerdict: ExpectedVerdict =
    asset.gate === null ? 'ungated' : kind === 'defect' ? 'fail' : 'pass';
  return {
    id: raw.id,
    gateClass: asset.gateClass,
    kind,
    manifest: {
      gate: asset.gate,
      defectMechanism: raw.defectMechanism,
      expectedVerdict,
      riskTier,
      boundaryTouching,
    },
    base: raw.base,
    head: raw.head,
    changedFiles,
    branch: `${asset.branchPrefix}/${raw.id.split('/').pop()}`,
    baseBranch: 'main',
    ...(raw.oracle ? { oracle: raw.oracle } : {}),
  };
}

function loadClassAsset(gateClass: GateClass): SeededFixture[] {
  const raw = JSON.parse(fs.readFileSync(assetPathFor(gateClass), 'utf-8')) as RawClassAsset;
  const fixtures: SeededFixture[] = [];
  for (const d of raw.defects) fixtures.push(resolveFixture(d, raw, 'defect'));
  for (const c of raw.controls) fixtures.push(resolveFixture(c, raw, 'control'));
  return fixtures;
}

/**
 * Load the seeded-defect corpus, optionally scoped to a single class.
 *
 * This is THE single loader API consumed by the catch-rate driver (task 004),
 * the gate-policy replay (006), and the DR-7 ratchet (013). Deterministic and
 * OFFLINE: reads the committed JSON assets and derives tier stamps via the
 * production classifier — no LLM, no network, no temp dirs, no spawns. Fixtures
 * come back in a stable order (class order, then defects then controls, by id).
 */
export function loadSeededCorpus(gateClass?: GateClass): SeededFixture[] {
  const classes = gateClass ? [gateClass] : SEEDED_GATE_CLASSES;
  const out: SeededFixture[] = [];
  for (const c of classes) out.push(...loadClassAsset(c));
  return out;
}

// ─── Materialization (disposable worktree) ────────────────────────────────────
//
// The gate handlers inspect a real git diff (`baseRef...HEAD`), so a fixture is
// exercised by materializing it into a throwaway git repo: the BASE map committed
// on `main`, then the HEAD map committed on a feature branch. Both the catch-rate
// driver and the hidden-oracle detector reuse this — single source, no per-caller
// git idioms.

/** A total git executor (a non-zero exit is a value, never a throw). */
export interface GitRun {
  (repoRoot: string, args: readonly string[]): { stdout: string; exitCode: number };
}

/** Result of materializing a fixture into a disposable worktree. */
export interface MaterializedFixture {
  readonly repoRoot: string;
  readonly branch: string;
  readonly baseBranch: string;
}

function writeFileMap(root: string, map: FileMap): void {
  for (const [rel, content] of Object.entries(map)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/**
 * Materialize a fixture into `repoRoot` (which must be an empty directory):
 * commit the BASE map on `main`, then commit the HEAD map on the fixture's
 * feature branch. The resulting `main...branch` diff is exactly the fixture's
 * changed set — precisely what the gate handlers inspect. Never throws on a
 * non-zero git exit; returns the branch coordinates the gate call needs.
 */
export function materializeFixture(
  fixture: SeededFixture,
  repoRoot: string,
  git: GitRun,
): MaterializedFixture {
  git(repoRoot, ['init', '--initial-branch=main', '-q']);
  git(repoRoot, ['config', 'user.email', 'seeded-corpus@exarchos.local']);
  git(repoRoot, ['config', 'user.name', 'exarchos-seeded-corpus']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);

  writeFileMap(repoRoot, fixture.base);
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', 'base: seeded-corpus merge-base']);

  git(repoRoot, ['checkout', '-q', '-b', fixture.branch]);
  // Remove any base-only paths, then lay down the full HEAD tree, so the diff is
  // accurate for adds, modifications, AND deletions.
  for (const rel of Object.keys(fixture.base)) {
    if (!(rel in fixture.head)) {
      fs.rmSync(path.join(repoRoot, rel), { force: true });
    }
  }
  writeFileMap(repoRoot, fixture.head);
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', `head: ${fixture.id}`]);

  return { repoRoot, branch: fixture.branch, baseBranch: fixture.baseBranch };
}

// ─── Hidden-oracle detector (dropped-edge-case class) ─────────────────────────
//
// No mechanical gate can catch a silently-dropped edge case, so this eval-side
// device does: materialize the HEAD tree, import the module-under-test, run each
// committed edge-case probe, and report whether the dropped edge is present. A
// DEFECT trips at least one probe (`detected: true`); a CONTROL passes them all.
// Used by task 006's escape computation and task 013's ratchet — never by a
// production gate.

const ORACLE_RUNNER = `import { readFileSync } from 'node:fs';
const spec = JSON.parse(readFileSync(new URL('./__oracle.json', import.meta.url), 'utf-8'));
const mod = await import(new URL(spec.module, import.meta.url));
const fn = mod[spec.export];
const failures = [];
for (const c of spec.cases) {
  let got;
  try { got = fn(...c.args); } catch (e) { got = '__threw__:' + (e && e.message); }
  if (JSON.stringify(got) !== JSON.stringify(c.expected)) {
    failures.push({ args: c.args, expected: c.expected, got });
  }
}
process.stdout.write(JSON.stringify({ detected: failures.length > 0, failures }));
`;

/** Outcome of running a dropped-edge-case fixture's hidden oracle. */
export interface OracleOutcome {
  /** True when the dropped edge was observed (≥1 probe mismatched). */
  readonly detected: boolean;
  /** The mismatching probes (empty when nothing detected). */
  readonly failures: ReadonlyArray<{ args: readonly unknown[]; expected: unknown; got: unknown }>;
}

/** Injectable node runner for {@link runDroppedEdgeOracle} (defaults to real spawn). */
export type NodeRunFn = (cwd: string, scriptFile: string) => { stdout: string; exitCode: number };

/**
 * Run a dropped-edge-case fixture's hidden oracle against its HEAD tree in a
 * throwaway directory. Materializes only the HEAD file-map (no git needed — the
 * oracle grades behavior, not a diff), writes the module + probe spec + a tiny
 * ESM runner, spawns node once, and parses the verdict. Deterministic + offline.
 *
 * Throws only for a misuse (a non-dropped-edge-case fixture / missing oracle).
 * A crashed/garbled runner surfaces as `detected: true` — a fixture whose module
 * cannot even be imported has, a fortiori, dropped its contract.
 */
export function runDroppedEdgeOracle(
  fixture: SeededFixture,
  deps?: { tmpRoot?: string; runNode?: NodeRunFn },
): OracleOutcome {
  if (fixture.gateClass !== 'dropped-edge-case' || !fixture.oracle) {
    throw new Error(`runDroppedEdgeOracle: ${fixture.id} is not a dropped-edge-case fixture`);
  }
  const tmpRoot = deps?.tmpRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'seeded-oracle-'));
  const owns = deps?.tmpRoot === undefined;
  try {
    writeFileMap(tmpRoot, fixture.head);
    fs.writeFileSync(path.join(tmpRoot, '__oracle.json'), JSON.stringify(fixture.oracle));
    fs.writeFileSync(path.join(tmpRoot, '__run-oracle.mjs'), ORACLE_RUNNER);
    const runNode = deps?.runNode ?? defaultRunNode;
    const res = runNode(tmpRoot, '__run-oracle.mjs');
    try {
      const parsed = JSON.parse(res.stdout) as OracleOutcome;
      return parsed;
    } catch {
      // Unparseable output → the module could not be imported/run at all.
      return { detected: true, failures: [{ args: [], expected: '<importable>', got: res.stdout.slice(0, 200) }] };
    }
  } finally {
    if (owns) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

const defaultRunNode: NodeRunFn = (cwd, scriptFile) => {
  try {
    const stdout = execFileSync(process.execPath, [scriptFile], {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.toString(), exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const out =
      (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '') +
      (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '');
    return { stdout: out, exitCode: e.status ?? 1 };
  }
};
