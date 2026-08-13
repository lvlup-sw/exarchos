/**
 * friction-signal — a stop-and-simplify signal for repeated INFRASTRUCTURE
 * failure (P07-07; dogfood exit criteria 10/14/15).
 *
 * When a tool is genuinely broken, retrying it is futile: the correct response
 * is to STOP grinding and simplify (use an alternative, clean up, or escalate).
 * This module watches a stream of failed operations, distinguishes an
 * INFRASTRUCTURE failure from a GENUINE TEST failure, and — only when the SAME
 * operation fails REPEATEDLY with the SAME typed infrastructure cause — emits a
 * `stop-and-simplify` {@link FrictionSignal}. A single genuine test failure (a
 * real red test) never produces a stop-and-simplify signal: a red test is a
 * signal to fix the code, not to abandon the tool.
 *
 * The distinction is the load-bearing part, so it is a pure, tested function
 * ({@link classifyFailure}) driven by an explicit catalog of infrastructure
 * signatures ({@link INFRA_SIGNATURES}) drawn from real failures observed on
 * this very program run:
 *   - the npm registry unreachable (SSL/TLS handshake failure) — retries are
 *     futile; use the junctioned `node_modules`;
 *   - a non-atomic `setup_worktree` leaving orphan worktrees/branches on disk;
 *   - a vitest worker RPC timeout that exits non-zero with ZERO failing tests —
 *     an infra flake that must NOT be mistaken for a real red test.
 *
 * Placement note (P07-07): this lives in the repo-root `src/` beside
 * `advisory-registry.ts` rather than in `src/telemetry/`
 * because the failures it watches are ORCHESTRATION-level infrastructure
 * operations (npm, worktree setup, the whole-suite test runner), not MCP
 * tool invocations, and because a telemetry module with no production importer
 * would itself register as dead-in-prod (DR-7) — the opposite of the friction
 * this package exists to reduce.
 */

// ─── Failure classification ──────────────────────────────────────────────────

/**
 * The class of a failed operation.
 *   - `infrastructure` — a broken tool/environment; retrying is futile.
 *   - `test-failure`   — a genuine red test; fix the code, don't simplify the tool.
 *   - `unknown`        — unclassified; never on its own triggers stop-and-simplify.
 */
export type FailureClass = 'infrastructure' | 'test-failure' | 'unknown';

/** A raw observation of a failed operation. */
export interface FailureObservation {
  /** The operation that failed, e.g. `npm install`, `setup_worktree`, `vitest run`. */
  readonly operation: string;
  /** The raw error text / log output produced by the failure. */
  readonly message: string;
  /**
   * How many tests were reported as FAILING, when the operation is a test run.
   * The vitest-worker-RPC infra flake is defined by exiting non-zero with ZERO
   * failing tests; any positive count means a genuine red test dominates and the
   * failure is classified `test-failure` regardless of message.
   */
  readonly failingTests?: number;
}

/** The verdict for one observation. */
export interface ClassifiedFailure {
  readonly operation: string;
  readonly class: FailureClass;
  /** The typed infrastructure cause id (empty unless `class` is `infrastructure`). */
  readonly cause: string;
}

/** One recognized infrastructure-failure signature. */
export interface InfraSignature {
  /** Stable typed cause id. */
  readonly cause: string;
  /** Human description of the failure mode. */
  readonly description: string;
  /** The stop-and-simplify remedy to surface when this fires repeatedly. */
  readonly remedy: string;
  /** True ⇒ this signature matches the given failure text. */
  readonly matches: (text: string) => boolean;
}

/**
 * The catalog of known infrastructure-failure signatures. Each was observed on
 * this program run. Ordered most-specific first; the first match wins.
 */
export const INFRA_SIGNATURES: readonly InfraSignature[] = [
  {
    cause: 'npm-registry-unreachable',
    description: 'The npm registry is unreachable — TLS/SSL handshake or connection failure.',
    remedy:
      'The npm registry is unreachable; retrying `npm install`/`npm ci` will keep failing. ' +
      'Stop and use the offline path (the junctioned node_modules / an existing cache).',
    matches: (t) =>
      /ERR_SSL|alert handshake failure|handshake failure|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(
        t,
      ) && /npm|registry|install|npmjs/i.test(t),
  },
  {
    cause: 'vitest-worker-rpc-timeout',
    description:
      'A vitest worker RPC timed out (e.g. `Timeout calling "onTaskUpdate"`), exiting non-zero with no failing tests.',
    remedy:
      'This is a vitest worker RPC infra flake, not a red test (zero tests failed). ' +
      'Do NOT "fix" passing code — re-run a narrowed suite or raise the worker timeout.',
    matches: (t) =>
      /\[vitest-worker\]/i.test(t) && /timeout calling/i.test(t),
  },
  {
    cause: 'worktree-nonatomic',
    description:
      'setup_worktree left orphaned worktrees/branches on disk with no corresponding event.',
    remedy:
      'setup_worktree is leaving orphaned worktrees/branches; re-running it compounds the mess. ' +
      'Stop, clean up the orphaned state, and make the setup atomic before retrying.',
    matches: (t) =>
      /worktree/i.test(t) &&
      /(orphan|no corresponding event|left .*on disk|already exists|non-atomic|not atomic)/i.test(t),
  },
];

/**
 * Classify a failed operation. Pure and total.
 *
 * A run that reports ≥1 failing test is a GENUINE `test-failure` regardless of
 * the message (a real red test is never "infrastructure"). Otherwise the first
 * matching {@link INFRA_SIGNATURES} entry classifies it as `infrastructure`
 * with that typed cause; if nothing matches, the class is `unknown`.
 */
export function classifyFailure(obs: FailureObservation): ClassifiedFailure {
  if (obs.failingTests !== undefined && obs.failingTests > 0) {
    return { operation: obs.operation, class: 'test-failure', cause: '' };
  }
  for (const sig of INFRA_SIGNATURES) {
    if (sig.matches(obs.message)) {
      return { operation: obs.operation, class: 'infrastructure', cause: sig.cause };
    }
  }
  return { operation: obs.operation, class: 'unknown', cause: '' };
}

/** Look up an infrastructure signature by its typed cause id. */
export function infraSignatureFor(cause: string): InfraSignature | undefined {
  return INFRA_SIGNATURES.find((s) => s.cause === cause);
}

// ─── The stop-and-simplify signal ────────────────────────────────────────────

/**
 * The number of consecutive same-(operation, cause) infrastructure failures at
 * which grinding is deemed futile and a stop-and-simplify signal is emitted.
 */
export const FRICTION_THRESHOLD = 3;

/** Emitted when an operation has failed too many times on the same infra cause. */
export interface FrictionSignal {
  readonly kind: 'stop-and-simplify';
  readonly operation: string;
  /** The typed infrastructure cause. */
  readonly cause: string;
  /** How many consecutive same-cause infrastructure failures were seen. */
  readonly occurrences: number;
  /** A human-facing stop-and-simplify recommendation. */
  readonly recommendation: string;
}

const KEY_SEP = '\u0000';
const streakKey = (operation: string, cause: string): string => `${operation}${KEY_SEP}${cause}`;

/**
 * Stateful monitor over a stream of failures. Tracks the consecutive run of
 * same-(operation, cause) infrastructure failures and emits a
 * {@link FrictionSignal} the moment that run reaches {@link FRICTION_THRESHOLD}
 * (and on every subsequent same-cause failure, with a growing `occurrences`).
 *
 * A `test-failure` or `unknown` observation for an operation RESETS that
 * operation's infra streaks — a run that failed for a non-infra reason is not
 * evidence that the *tool* is broken — so a single genuine test failure never
 * yields a stop-and-simplify signal.
 */
export class FrictionMonitor {
  private readonly streaks = new Map<string, number>();

  /**
   * Record one failed operation. Returns a {@link FrictionSignal} when the
   * futility threshold is reached, else `null`.
   */
  observe(obs: FailureObservation): FrictionSignal | null {
    const verdict = classifyFailure(obs);

    if (verdict.class !== 'infrastructure') {
      // Non-infra outcome for this operation clears its infra streaks: the tool
      // is not (yet) demonstrably broken.
      this.clearOperation(verdict.operation);
      return null;
    }

    const key = streakKey(verdict.operation, verdict.cause);
    const occurrences = (this.streaks.get(key) ?? 0) + 1;
    this.streaks.set(key, occurrences);

    if (occurrences < FRICTION_THRESHOLD) return null;

    const sig = infraSignatureFor(verdict.cause);
    return {
      kind: 'stop-and-simplify',
      operation: verdict.operation,
      cause: verdict.cause,
      occurrences,
      recommendation:
        sig?.remedy ??
        `Operation "${verdict.operation}" has failed ${occurrences}× on infrastructure ` +
          `cause "${verdict.cause}" — stop retrying and simplify.`,
    };
  }

  /** Record that an operation SUCCEEDED, clearing its infra streaks. */
  recordSuccess(operation: string): void {
    this.clearOperation(operation);
  }

  /** Current consecutive same-cause infra streak for diagnostics/tests. */
  streakFor(operation: string, cause: string): number {
    return this.streaks.get(streakKey(operation, cause)) ?? 0;
  }

  private clearOperation(operation: string): void {
    const prefix = `${operation}${KEY_SEP}`;
    for (const key of [...this.streaks.keys()]) {
      if (key.startsWith(prefix)) this.streaks.delete(key);
    }
  }
}

/**
 * Fold a whole sequence of observations through a fresh {@link FrictionMonitor}
 * and return every stop-and-simplify signal emitted, in order. Pure over its
 * input — useful for batch analysis of a run log and for tests.
 */
export function evaluateFrictionRun(
  observations: readonly FailureObservation[],
): FrictionSignal[] {
  const monitor = new FrictionMonitor();
  const signals: FrictionSignal[] = [];
  for (const obs of observations) {
    const sig = monitor.observe(obs);
    if (sig) signals.push(sig);
  }
  return signals;
}
