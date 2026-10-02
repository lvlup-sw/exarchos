// RESERVED(issue: #1764, owner: exarchos, expires: 2027-02-28) — dormant orchestration
// telemetry with no production importer. Only its own test keeps it alive. The
// module-intent gate requires its deletion at expiry if no caller adopts it.
/**
 * A stop-and-simplify signal for repeated infrastructure failure.
 * When a tool is broken, a retry does not help. The correct response is to stop and simplify.
 * {@link classifyFailure} and the {@link INFRA_SIGNATURES} catalog tell an infrastructure failure from a genuine test failure.
 * A signal occurs only when the same operation fails again and again with the same infrastructure cause.
 * A red test is a signal to fix the code, so it never produces this signal.
 *
 * The module watches orchestration-level operations (npm, worktree setup, the test runner), not MCP tool calls.
 */

/**
 * The class of a failed operation.
 *   - `infrastructure` — a broken tool or environment. A retry does not help.
 *   - `test-failure`   — a genuine red test. The code needs a fix, not the tool.
 *   - `unknown`        — not classified. It never triggers stop-and-simplify on its own.
 */
export type FailureClass = 'infrastructure' | 'test-failure' | 'unknown';

/** A raw observation of a failed operation. */
export interface FailureObservation {
  /** The operation that failed, for example `npm install`, `setup_worktree`, or `vitest run`. */
  readonly operation: string;
  /** The raw error text / log output produced by the failure. */
  readonly message: string;
  /**
   * The number of failing tests, when the operation is a test run.
   * A positive count classifies the failure as `test-failure`, whatever the message.
   * The vitest worker RPC flake exits non-zero with zero failing tests.
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

/** The catalog of known infrastructure-failure signatures. The first match wins. */
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
 * Classify a failed operation.
 * A run with one or more failing tests is a `test-failure`, whatever the message.
 * Otherwise the first matching {@link INFRA_SIGNATURES} entry gives `infrastructure` with its cause. With no match, the class is `unknown`.
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
 * A stateful monitor over a stream of failures. It counts the infrastructure failures for each operation and cause.
 * It emits a {@link FrictionSignal} when a count reaches {@link FRICTION_THRESHOLD}, and again on each later failure with that cause.
 * A `test-failure` or `unknown` result, or a success, clears each streak of that operation.
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

/** Pass each observation through a new {@link FrictionMonitor}, and return the emitted signals in order. */
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
