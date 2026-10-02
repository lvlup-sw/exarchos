/**
 * The blocking ratchet for runtime import cycles in `src`.
 *
 * It runs `dependency-cruiser`, finds runtime cycles with the shared detector in
 * `import-cycles.ts`, and compares them to `cycle-baseline.json`. It exits 1 for
 * an unbaselined cycle edge, an expired waiver, or a phantom entry. A phantom
 * entry matches no live edge and pre-authorizes a future cycle on that edge. It
 * exits 2 when it cannot verify the surface.
 *
 * `.dependency-cruiser.cjs` sets `no-circular` to `warn`, so the
 * static-analysis leg stays green. This gate holds the blocking enforcement.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { edgeRegisterSchema, isEntryExpired, type EdgeRegisterEntry } from './register-entry-schema.js';
import {
  scanRuntimeCycleGraph,
  unbaselinedCycleEdges,
  phantomBaselineEntries,
  edgeKey,
  EmptyCycleGraphError,
  type RuntimeCycleScan,
} from '../conformance/src/import-cycles.js';

/** Repo-relative source root the ratchet governs (matches import-cycles default). */
export const SRC_PREFIX = 'src';

export { EmptyCycleGraphError };

/** Thrown when the depcruise output does not parse into a graph. */
export class CycleGraphParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleGraphParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Detects the runtime cycles in a depcruise JSON graph. Malformed input throws
 * {@link CycleGraphParseError}, so the caller fails closed and does not read
 * bad output as acyclic. It returns the whole scan, so the OK line can report
 * the measured population.
 */
export function detectCyclesOrThrow(raw: string, srcPrefix = SRC_PREFIX): RuntimeCycleScan {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new CycleGraphParseError('depcruise produced empty output (expected a JSON graph)');
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    throw new CycleGraphParseError(`depcruise did not emit valid JSON (${(err as Error).message})`);
  }
  if (!isRecord(json) || !Array.isArray(json.modules)) {
    throw new CycleGraphParseError('depcruise JSON is missing the expected top-level `modules[]` array');
  }
  return scanRuntimeCycleGraph(trimmed, srcPrefix);
}

/**
 * The validated baseline document. Its entries use the narrow `EdgeRegisterEntry`
 * type (`permanent?: true`). The graph helpers and `isEntryExpired` both accept
 * this type. `isEntryExpired` rejects the wide `permanent?: boolean` type.
 */
export interface ValidatedCycleBaseline {
  readonly entries: readonly EdgeRegisterEntry[];
}

/**
 * Validates the raw `cycle-baseline.json` document. It ignores the metadata
 * fields and validates each item of `entries[]` against {@link edgeRegisterSchema}.
 */
export function loadCycleBaseline(raw: unknown): ValidatedCycleBaseline {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) {
    throw new Error('cycle-baseline.json is missing the expected top-level `entries[]` array');
  }
  const result = z.array(edgeRegisterSchema).safeParse(raw.entries);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - [entries.${issue.path.join('.') || '(root)'}] ${issue.message}`)
      .join('\n');
    throw new Error(`cycle-baseline.json failed schema validation:\n${detail}`);
  }
  return { entries: result.data };
}

export const EXIT_OK = 0;
/** A real cycle-surface finding: unbaselined, expired, or phantom. */
export const EXIT_VIOLATIONS = 1;
/** The gate cannot verify the surface, so it fails closed. */
export const EXIT_GATE_ERROR = 2;

export interface DepcruiseRun {
  /** Was the depcruise binary resolvable and spawnable? `false` ⇒ tool-missing. */
  readonly found: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly binPath: string;
}

export interface CycleGateDeps {
  readonly runDepcruise: () => DepcruiseRun;
  readonly readBaseline: () => unknown;
  readonly now: Date;
  readonly log: (message: string) => void;
  readonly errlog: (message: string) => void;
  /** Tests can override it. The default is {@link SRC_PREFIX}. */
  readonly srcPrefix?: string;
}

/**
 * The gate body. It has no process, file system, or child-process access of its
 * own. An empty first-party graph gets its own reason, so an operator can tell a
 * moved source root from bad output. The OK line reports the module and edge
 * counts, because a scan of nothing also finds 0 cycles.
 */
export function runCycleGate(deps: CycleGateDeps): number {
  const srcPrefix = deps.srcPrefix ?? SRC_PREFIX;

  const run = deps.runDepcruise();
  if (!run.found) {
    deps.errlog(
      `[cycle-gate] FAIL (tool-missing): dependency-cruiser binary not found at ${run.binPath}. ` +
        'Cannot verify the runtime import-cycle surface — failing closed. ' +
        'Run `npm ci` at the repo root to install devDependencies.',
    );
    return EXIT_GATE_ERROR;
  }

  let scan: RuntimeCycleScan;
  try {
    scan = detectCyclesOrThrow(run.stdout, srcPrefix);
  } catch (err) {
    if (err instanceof EmptyCycleGraphError) {
      deps.errlog(
        `[cycle-gate] FAIL (empty-graph): ${err.message} ` +
          `depcruise exited ${run.code}. Failing closed.`,
      );
      return EXIT_GATE_ERROR;
    }
    const detail = err instanceof CycleGraphParseError ? err.message : (err as Error).message;
    deps.errlog(
      `[cycle-gate] FAIL (unparseable-output): ${detail}. ` +
        `depcruise exited ${run.code}; stdout head=${JSON.stringify(run.stdout.slice(0, 160))}; ` +
        `stderr head=${JSON.stringify(run.stderr.slice(0, 160))}. Failing closed.`,
    );
    return EXIT_GATE_ERROR;
  }
  const cycles = scan.cycles;

  let baseline: ValidatedCycleBaseline;
  try {
    baseline = loadCycleBaseline(deps.readBaseline());
  } catch (err) {
    deps.errlog(`[cycle-gate] FAIL (bad-baseline): ${(err as Error).message}`);
    return EXIT_GATE_ERROR;
  }

  const unbaselined = unbaselinedCycleEdges(cycles, baseline);
  const expired = baseline.entries.filter((entry) => isEntryExpired(entry, deps.now));
  const phantom = phantomBaselineEntries(cycles, baseline);

  let failed = false;
  if (unbaselined.length > 0) {
    failed = true;
    deps.errlog(
      `[cycle-gate] FAIL (unbaselined-cycle): ${unbaselined.length} runtime import cycle edge(s) ` +
        'with no entry in cycle-baseline.json — break the cycle by extraction (preferred) or add ' +
        'a tracked entry with owner/issue/expiry/rationale:',
    );
    for (const edge of unbaselined) deps.errlog(`    ${edgeKey(edge)}`);
  }
  if (expired.length > 0) {
    failed = true;
    deps.errlog(
      `[cycle-gate] FAIL (expired): ${expired.length} baseline waiver(s) past their review ` +
        'deadline — break the cycle or renew `expires`:',
    );
    for (const e of expired) {
      deps.errlog(`    ${edgeKey({ from: e.from, to: e.to })} (owner ${e.owner}, expired ${e.expires ?? '?'})`);
    }
  }
  if (phantom.length > 0) {
    failed = true;
    deps.errlog(
      `[cycle-gate] FAIL (phantom): ${phantom.length} baseline entr${phantom.length === 1 ? 'y' : 'ies'} ` +
        'match NO live runtime cycle edge — stale cover that pre-authorizes a future cycle on that ' +
        'seam. Delete it from cycle-baseline.json (the cycle is already gone):',
    );
    for (const e of phantom) deps.errlog(`    ${edgeKey({ from: e.from, to: e.to })} (owner ${e.owner})`);
  }
  if (failed) return EXIT_VIOLATIONS;

  deps.log(
    `[cycle-gate] OK: ${cycles.length} runtime cycle(s) over ${scan.nodeCount} first-party ` +
      `module(s) / ${scan.edgeCount} runtime edge(s) under ${srcPrefix}, all baselined & ` +
      `unexpired (${baseline.entries.length} entr${baseline.entries.length === 1 ? 'y' : 'ies'} ` +
      'in cycle-baseline.json).',
  );
  return EXIT_OK;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BASELINE_PATH = path.join(HERE, 'cycle-baseline.json');
const DEPCRUISE_CONFIG = path.join(REPO_ROOT, '.dependency-cruiser.cjs');

/**
 * Runs the root depcruise binary from the repo root, so module paths are
 * repo-relative (`src/…`) like {@link SRC_PREFIX} and the baseline. A spawn
 * error, for example on win32, returns `found: false`, and the gate fails
 * closed. `EXARCHOS_DEPCRUISE_BIN` overrides the binary path, so the shell
 * self-test can reach the tool-missing and unparseable-output paths. The gate
 * reads stdout for each exit code, because `no-circular` is only `warn`.
 */
function defaultRunDepcruise(): DepcruiseRun {
  const binPath = process.env.EXARCHOS_DEPCRUISE_BIN ?? path.join(REPO_ROOT, 'node_modules', '.bin', 'depcruise');
  const res = spawnSync(
    binPath,
    ['--config', DEPCRUISE_CONFIG, '--output-type', 'json', SRC_PREFIX],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) {
    return { found: false, code: -1, stdout: res.stdout ?? '', stderr: res.error.message, binPath };
  }
  return {
    found: true,
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    binPath,
  };
}

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsCli()) {
  const exitCode = runCycleGate({
    runDepcruise: defaultRunDepcruise,
    readBaseline: () => JSON.parse(readFileSync(BASELINE_PATH, 'utf8')),
    now: new Date(),
    log: (message) => process.stdout.write(`${message}\n`),
    errlog: (message) => process.stderr.write(`${message}\n`),
  });
  process.exit(exitCode);
}
