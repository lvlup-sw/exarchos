/**
 * The seeded-defect corpus: defect inputs that must fail verification, and matched known-good
 * controls, in six classes.
 *
 * Five classes target an `exarchos_orchestrate` gate (see `GATE_FOR_CLASS`). The
 * `dropped-edge-case` class has no production gate. The eval-side hidden oracle
 * ({@link runDroppedEdgeOracle}) detects it, and it is never a row in the catch-rate table.
 *
 * Fixtures are JSON file maps under `fixtures/`, one file per class. The typecheck and the lint
 * exclude that directory, so broken defect content cannot fail repo CI. The production classifier
 * derives the tier stamps of each fixture from its changed file paths.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCommandSync } from '../../../../../src/utils/process.js';
import {
  deriveRiskTier,
  deriveBoundaryTouching,
  type RiskTier,
} from '../../../../../src/verbs/team/prepare-delegation.js';
import type { MechanicalGateClass } from '../../../../../src/verbs/gates/gate-provider-registry.js';

/**
 * The six seeded-defect classes: the five mechanical classes and `dropped-edge-case`.
 * `gate-provider-registry.ts` owns the mechanical classes, so production does not import this eval
 * corpus and the two taxonomies cannot drift.
 */
export type GateClass = MechanicalGateClass | 'dropped-edge-case';

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

/** Whether a fixture is a seeded defect or a matched known-good control. */
export type FixtureKind = 'defect' | 'control';

/**
 * The verdict that a correct gate returns for a fixture:
 *   - `fail`: a seeded defect that the gate must flag (true positive).
 *   - `pass`: a control that the gate must leave clean (no false positive).
 *   - `ungated`: a dropped-edge-case fixture. No production gate targets it. The hidden oracle detects it.
 */
export type ExpectedVerdict = 'fail' | 'pass' | 'ungated';

/** A repo-relative path → file-content map (materialized into a worktree). */
export type FileMap = Readonly<Record<string, string>>;

/**
 * The hidden-oracle spec for a dropped-edge-case fixture. The oracle imports the named `export` of
 * `module` from the HEAD tree and runs each edge `case`. A mismatch shows the dropped edge.
 */
export interface OracleSpec {
  /** Repo-relative ESM module in the fixture HEAD, for example `src/clamp.mjs`. */
  readonly module: string;
  /** The named export under test. */
  readonly export: string;
  /** Edge-case probes: call `export(...args)` and compare to `expected`. */
  readonly cases: ReadonlyArray<{ readonly args: readonly unknown[]; readonly expected: unknown }>;
}

/** The manifest fields on every fixture. */
export interface FixtureManifest {
  /** The `exarchos_orchestrate` gate this class targets (`null` = ungated). */
  readonly gate: string | null;
  /** Human description of the seeded defect mechanism (or the control's shape). */
  readonly defectMechanism: string;
  /** The verdict that a correct gate returns. */
  readonly expectedVerdict: ExpectedVerdict;
  /** DERIVED by `deriveRiskTier` from the changed file paths — never hand-set. */
  readonly riskTier: RiskTier;
  /** DERIVED by `deriveBoundaryTouching` from the changed file paths. */
  readonly boundaryTouching: boolean;
}

/** A fully-resolved corpus fixture returned by {@link loadSeededCorpus}. */
export interface SeededFixture {
  /** Stable id, for example `test-adequacy/defect-01`. */
  readonly id: string;
  /** The defect class. */
  readonly gateClass: GateClass;
  /** Whether the fixture is a defect or a control. */
  readonly kind: FixtureKind;
  /** The gate, the mechanism, the verdict, and the derived tiers. */
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, 'fixtures');

/** The per-class asset filename. */
function assetPathFor(gateClass: GateClass): string {
  return path.join(FIXTURES_DIR, `${gateClass}.json`);
}

/**
 * Returns the sorted repo-relative paths that differ between `base` and `head`, the same set as
 * `git diff --name-only base...HEAD`. Added, changed, and deleted paths all count.
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
 * Derives the risk tier and the boundary flag from the changed file paths with the production
 * classifier. The stamps are never values in the asset. The tests call this to prove the derivation.
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
 * Loads the seeded-defect corpus, or one class of it. It reads the committed JSON assets and derives
 * the tier stamps, with no LLM, network, temp directory, or spawn. The order is stable: class order,
 * then the defects, then the controls.
 */
export function loadSeededCorpus(gateClass?: GateClass): SeededFixture[] {
  const classes = gateClass ? [gateClass] : SEEDED_GATE_CLASSES;
  const out: SeededFixture[] = [];
  for (const c of classes) out.push(...loadClassAsset(c));
  return out;
}

/** A total git executor (a non-zero exit is a value, never a throw). */
export interface GitRun {
  (repoRoot: string, args: readonly string[]): { stdout: string; exitCode: number };
}

/**
 * A git setup command failed in {@link materializeFixture}. The caller records an explicit
 * `invalid` cell for it, never a verdict from a partial worktree.
 */
export class FixtureMaterializationError extends Error {
  constructor(args: readonly string[], exitCode: number, stdout: string) {
    super(`git ${args.join(' ')} exited ${exitCode}${stdout ? `: ${stdout.trim()}` : ''}`);
    this.name = 'FixtureMaterializationError';
  }
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
 * Materializes a fixture into the empty directory `repoRoot`, for gate handlers that read a real
 * git diff. It commits the BASE map on `main`, then the HEAD map on the fixture branch. On the
 * branch, it deletes the base-only paths before it writes HEAD, so the diff shows deletions.
 *
 * `git` returns an exit code and never throws. Any non-zero exit throws
 * {@link FixtureMaterializationError}, because a partial worktree gives a verdict that nobody can trust.
 */
export function materializeFixture(
  fixture: SeededFixture,
  repoRoot: string,
  git: GitRun,
): MaterializedFixture {
  const run = (args: readonly string[]): void => {
    const { exitCode, stdout } = git(repoRoot, args);
    if (exitCode !== 0) throw new FixtureMaterializationError(args, exitCode, stdout);
  };

  run(['init', '--initial-branch=main', '-q']);
  run(['config', 'user.email', 'seeded-corpus@exarchos.local']);
  run(['config', 'user.name', 'exarchos-seeded-corpus']);
  run(['config', 'commit.gpgsign', 'false']);

  writeFileMap(repoRoot, fixture.base);
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'base: seeded-corpus merge-base']);

  run(['checkout', '-q', '-b', fixture.branch]);
  for (const rel of Object.keys(fixture.base)) {
    if (!(rel in fixture.head)) {
      fs.rmSync(path.join(repoRoot, rel), { force: true });
    }
  }
  writeFileMap(repoRoot, fixture.head);
  run(['add', '-A']);
  run(['commit', '-q', '-m', `head: ${fixture.id}`]);

  return { repoRoot, branch: fixture.branch, baseBranch: fixture.baseBranch };
}

/** The ESM script that runs each oracle probe and prints `{ detected, failures }` as JSON. */
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
 * Runs the hidden oracle of a dropped-edge-case fixture against its HEAD tree in a temp directory.
 * It writes the HEAD file map, the probe spec, and the ESM runner, then spawns node once. It uses
 * no git, because the oracle grades behavior, not a diff.
 *
 * It throws for a fixture that is not a dropped-edge-case fixture with an oracle. Runner output
 * that does not parse gives `detected: true`, because a module that cannot load has dropped its contract.
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
      return { detected: true, failures: [{ args: [], expected: '<importable>', got: res.stdout.slice(0, 200) }] };
    }
  } finally {
    if (owns) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Spawns node through the win32-safe `spawnCommandSync` helper. On a non-zero exit, a timeout, or a
 * spawn error, it returns stdout plus stderr, so an unimportable module shows as a detection.
 */
const defaultRunNode: NodeRunFn = (cwd, scriptFile) => {
  const res = spawnCommandSync(process.execPath, [scriptFile], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (res.status === 0 && res.error === undefined) {
    return { stdout: res.stdout ?? '', exitCode: 0 };
  }
  return { stdout: (res.stdout ?? '') + (res.stderr ?? ''), exitCode: res.status ?? 1 };
};
