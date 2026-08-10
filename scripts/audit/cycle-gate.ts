/**
 * cycle-gate.ts — the DR-4/DR-8 no-circular blocking ratchet.
 *
 * Runs `dependency-cruiser` over `servers/exarchos-mcp/src`, computes the RUNTIME
 * import cycles itself (Tarjan SCC via architecture/import-cycles.ts — the single
 * acceptance instrument, shared with the MCP `import-cycles.test.ts` regression),
 * and diffs them against `cycle-baseline.json`. The gate FAILS CLOSED — it exits
 * non-zero, and never silently passes — on any of the FOUR DR-4 failure modes:
 *
 *   (a) unbaselined cycle   → a live runtime cycle with no baseline entry
 *   (b) expired entry       → a baseline waiver past its review deadline
 *   (c) PHANTOM entry       → a baseline entry matching NO live cycle edge (the
 *                             no-mask tooth: stale cover pre-authorizing a future
 *                             cycle on that exact seam — a hard FAIL here, unlike
 *                             knip's `stale`, which is only a hygiene warning)
 *   (d) tool-missing /      → depcruise absent, or its output is empty/unparseable
 *       unparseable output    (DR-8: cannot verify the surface → fail closed)
 *   (e) EMPTY GRAPH         → the output parsed, but no first-party module
 *                             resolved under `srcPrefix`. An empty node set
 *                             yields an empty cycle list, which is the same
 *                             value a clean tree yields — so this gate used to
 *                             print `OK: 0 runtime cycle(s)` and exit 0 for a
 *                             relocated source root (DR-8, task 079).
 *
 * (a)/(b)/(c) exit 1 (a real cycle-surface finding); the DR-8 "can't verify"
 * causes exit 2, so CI can tell "there is an unacceptable cycle" from "the gate
 * itself broke". Both are blocking. The pure `runCycleGate(deps)` body and
 * `loadCycleBaseline` are exported so every fail-closed path is unit-testable
 * without spawning depcruise.
 *
 * Severity note: the shared `.dependency-cruiser.cjs` ships `no-circular` at
 * `warn`, NOT `error`, so the dogfooded static-analysis leg (`runBoundaryLint`,
 * which folds any non-zero `depcruise --validate` exit into a FAIL) stays green.
 * Blocking enforcement is HERE, over the `--output-type json` graph — not in the
 * config's severity.
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
} from '../../servers/exarchos-mcp/src/architecture/import-cycles.js';

/** Repo-relative source root the ratchet governs (matches import-cycles default). */
export const SRC_PREFIX = 'servers/exarchos-mcp/src';

/**
 * Re-exported so the gate presents ONE error vocabulary to its callers and
 * tests. `EmptyCycleGraphError` is raised by the detector, but it is a
 * gate-level fail-closed reason (exit 2), so a consumer should not have to reach
 * into `architecture/import-cycles.js` to name it.
 */
export { EmptyCycleGraphError };

/** Thrown when depcruise output cannot be parsed into a graph (DR-8). */
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
 * Detect the runtime cycles in a depcruise JSON graph, converting any malformed
 * input into a {@link CycleGraphParseError} so the caller can fail closed instead
 * of treating garbage as "acyclic".
 *
 * Returns the SCAN, not just the cycles: the gate reports the population it
 * measured, so an operator reading the OK line can tell "no cycle in 600
 * modules" from "no cycle in nothing" (DR-8, task 079).
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
  // import-cycles re-parses the text; safe because we already proved it is valid.
  return scanRuntimeCycleGraph(trimmed, srcPrefix);
}

/**
 * The validated baseline document. Its entries carry the NARROW `EdgeRegisterEntry`
 * type (`permanent?: true`), which is a subtype of `import-cycles`'s
 * `CycleBaselineEntry` (`permanent?: boolean`) — so it flows unchanged into the
 * graph helpers (`unbaselinedCycleEdges` / `phantomBaselineEntries`) AND into
 * `isEntryExpired`, whose `permanent?: true` contract the wide type would reject.
 */
export interface ValidatedCycleBaseline {
  readonly entries: readonly EdgeRegisterEntry[];
}

/**
 * Validate the raw `cycle-baseline.json` document against the shared edge-register
 * contract. Tolerates the doc's `version` / `instrument` / `entryShape` metadata
 * and validates only `entries[]` — each against {@link edgeRegisterSchema}.
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
/** Fail-closed: the gate itself could not verify the surface (DR-8). */
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
  /** Overridable for tests; defaults to {@link SRC_PREFIX}. */
  readonly srcPrefix?: string;
}

/** Injectable gate body — no process/FS/child_process access of its own. */
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
    // An empty first-party node set gets its OWN reason (DR-8, task 079). It
    // parsed fine — the prefix simply matched nothing, which used to yield an
    // empty cycle list and an `OK … 0 runtime cycle(s)` exit 0. Naming it
    // separately from "unparseable" is what lets an operator tell a moved source
    // root from garbage on stdout.
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

  // The OK line reports the POPULATION, not just the finding. "0 cycles" is the
  // healthy answer and also the answer a scan of nothing gives, so the number
  // that makes the verdict readable is the denominator.
  deps.log(
    `[cycle-gate] OK: ${cycles.length} runtime cycle(s) over ${scan.nodeCount} first-party ` +
      `module(s) / ${scan.edgeCount} runtime edge(s) under ${srcPrefix}, all baselined & ` +
      `unexpired (${baseline.entries.length} entr${baseline.entries.length === 1 ? 'y' : 'ies'} ` +
      'in cycle-baseline.json).',
  );
  return EXIT_OK;
}

// ─── production wiring (only runs when invoked as a CLI) ────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BASELINE_PATH = path.join(HERE, 'cycle-baseline.json');
const DEPCRUISE_CONFIG = path.join(REPO_ROOT, '.dependency-cruiser.cjs');

/**
 * Run depcruise from the repo root so the emitted module paths are repo-relative
 * (`servers/exarchos-mcp/src/…`) — matching {@link SRC_PREFIX} and the baseline's
 * documented `from`/`to` convention. Uses the ROOT-hoisted binary (task 010).
 * Mirrors knip-diff's `defaultRunKnip`: this CI gate runs on ubuntu; a spawn
 * failure (incl. win32, where Node cannot exec the shell shim directly) degrades
 * to `found:false` → fail-closed tool-missing. win32 runtime-cycle coverage is
 * the MCP `import-cycles.test.ts` lane, which uses the win32-correct spawn shim.
 */
function defaultRunDepcruise(): DepcruiseRun {
  // Binary path is overridable via EXARCHOS_DEPCRUISE_BIN so the DR-8 fail-closed
  // paths (tool-missing / unparseable-output) are exercisable from the unfiltered
  // grep-gates `.test.sh` self-test without uninstalling depcruise: point it at a
  // missing path (→ found:false, tool-missing) or a stub that emits garbage
  // (→ unparseable-output). Mirrors the `--refgraph` / `--manifest` seams the
  // sibling `.mjs` gates already expose for the same reason.
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
    // depcruise exits non-zero only for ERROR-severity violations; no-circular is
    // `warn`, so a clean tree exits 0. The gate reads stdout regardless of code.
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
