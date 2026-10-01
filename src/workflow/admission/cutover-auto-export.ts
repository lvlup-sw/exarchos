// Cutover readiness auto-export. The promotion path learns that it is ready
// without an operator who polls `cutover_readiness`.
//
// The module hooks the durable-append success seam of the observer. The seam is
// a listener because the observer cannot import the gate without a runtime
// cycle. The first time that all six conditions hold, the hook writes the full
// report to `<stateDir>/admission/cutover-readiness.json` with an atomic write.
// Then it appends one `admission.cutover-ready` fact to the `exarchos-admission`
// stream.
//
// The hook never throws into the transition path. It counts each failure, and
// the next durable-append success retries.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { ADMISSION_STREAM_ID } from '../../dispatch/core/infra-streams.js';
import { AdmissionCutoverReadyData } from '../../events/schemas.js';
import { atomicWriteFile } from '../../utils/atomic-write.js';
import {
  MINIMUM_LIVE_ATTEMPTS,
  type LiveShadowAttempt,
} from './cutover-gate.js';
import {
  assessDurableCutoverReadiness,
  contentDigestOf,
  type ShadowEvidenceSource,
} from './evidence-reader.js';
import {
  liveShadowHealth,
  liveShadowSink,
  setDurableAppendSuccessListener,
  type LiveShadowHealth,
  type ShadowEvidenceAppender,
} from './live-shadow-observer.js';
import {
  ADMISSION_EVENT_TYPES,
  AttributedPrincipalV1Schema,
  AuthorizationSnapshotV1Schema,
} from './types.js';

/** One local store, readable (enumeration + query) AND appendable. */
export interface CutoverAutoExportStore extends ShadowEvidenceSource {
  append: ShadowEvidenceAppender['append'];
}

export interface CutoverAutoExportConfig {
  readonly store: CutoverAutoExportStore;
  /** The store's state directory — both the export root and the identity input. */
  readonly stateDir: string;
  /** Live-attempt source. The default is the process-level {@link liveShadowSink}. */
  readonly liveAttempts?: () => readonly LiveShadowAttempt[];
  /** Health source. The default is the process-level {@link liveShadowHealth}. */
  readonly observerHealth?: () => LiveShadowHealth;
  /** Trusted payload instant (NEVER identity — see the key derivation). */
  readonly now?: () => string;
}

/** The export artifact's path, relative to the configured stateDir. */
export const CUTOVER_READINESS_EXPORT_SEGMENTS: readonly string[] = Object.freeze([
  'admission',
  'cutover-readiness.json',
]);

/** `event.source` stamped on the readiness fact. */
export const CUTOVER_AUTO_EXPORT_SOURCE = 'cutover-auto-export';

/**
 * The first-readiness idempotency key for one store. It is a pure function of
 * the stateDir path, with no clock or random input. Thus every process, restart,
 * and retry over the same store derives the same key, and the append dedupes.
 */
export function cutoverReadinessIdempotencyKey(stateDir: string): string {
  const digest = createHash('sha256').update(stateDir, 'utf8').digest('hex');
  return `cutover-ready:${digest}`;
}

interface AutoExportState {
  config: CutoverAutoExportConfig | undefined;
  /** First-time latch: set only after the readiness fact LANDED. */
  exported: boolean;
  /** Full (post-pre-filter) evaluations run. */
  evaluations: number;
  /** Swallowed-but-counted export failures. */
  failures: number;
  inFlight: Promise<void> | undefined;
}

const state: AutoExportState = {
  config: undefined,
  exported: false,
  evaluations: 0,
  failures: 0,
  inFlight: undefined,
};

/**
 * Install the auto-export wiring, or tear it down with `undefined`. It stores
 * the config, resets the latch and counters, and registers
 * {@link maybeExportCutoverReadiness} on the durable-append success seam of the
 * observer. `dispatch/core/context.ts` calls it with the real store.
 */
export function configureCutoverAutoExport(
  config: CutoverAutoExportConfig | undefined,
): void {
  state.config = config;
  state.exported = false;
  state.evaluations = 0;
  state.failures = 0;
  setDurableAppendSuccessListener(
    config === undefined ? undefined : maybeExportCutoverReadiness,
  );
}

/** Read-only diagnostics (tests + doctor probes). */
export function cutoverAutoExportDiagnostics(): {
  readonly configured: boolean;
  readonly exported: boolean;
  readonly evaluations: number;
  readonly failures: number;
} {
  return {
    configured: state.config !== undefined,
    exported: state.exported,
    evaluations: state.evaluations,
    failures: state.failures,
  };
}

/** Await any in-flight export evaluation. Never throws. */
export async function flushCutoverAutoExport(): Promise<void> {
  while (state.inFlight !== undefined) {
    await state.inFlight;
  }
}

/**
 * The durable-append success hook. The entry is synchronous because the
 * settlement chain of the observer must not await it. The full evaluation runs
 * on one tracked promise at a time.
 *
 * An in-memory pre-filter runs first. Below `MINIMUM_LIVE_ATTEMPTS` observed
 * attempts the gate cannot pass, so the hook does not read the store. The
 * rejection arm exists only to stop an unhandled rejection, because `runExport`
 * counts its own failures.
 */
export function maybeExportCutoverReadiness(): void {
  const config = state.config;
  if (config === undefined || state.exported) return;

  const health = (config.observerHealth ?? processObserverHealth)();
  if (health.attemptsObserved < MINIMUM_LIVE_ATTEMPTS) return;

  if (state.inFlight !== undefined) return;
  const run = runExport(config, health).then(
    () => undefined,
    () => {
      state.failures += 1;
    },
  );
  state.inFlight = run;
  void run.finally(() => {
    state.inFlight = undefined;
  });
}

function processObserverHealth(): LiveShadowHealth {
  return liveShadowHealth.snapshot();
}

/**
 * Evaluate durable readiness, then write the report and append the fact once.
 * A failure increments the counter and never throws, so it cannot block the
 * transition whose durable append started it.
 */
async function runExport(
  config: CutoverAutoExportConfig,
  observerHealth: LiveShadowHealth,
): Promise<void> {
  try {
    state.evaluations += 1;
    const liveAttempts = (config.liveAttempts ?? processLiveAttempts)();
    const { report } = await assessDurableCutoverReadiness(config.store, {
      liveAttempts,
      observerHealth,
    });
    if (!report.satisfied || state.exported) return;

    const recordedAt = (config.now ?? defaultNow)();
    const reportPath = join(config.stateDir, ...CUTOVER_READINESS_EXPORT_SEGMENTS);
    const content = JSON.stringify({ recordedAt, report }, null, 2);
    mkdirSync(dirname(reportPath), { recursive: true });
    atomicWriteFile(reportPath, content);

    const readinessId = cutoverReadinessIdempotencyKey(config.stateDir);
    const data = AdmissionCutoverReadyData.parse({
      eventVersion: '1.0',
      readinessId,
      reportPath,
      reportDigest: contentDigestOf(content),
      comparableLiveAttemptCount: report.comparableLiveAttemptCount,
      durableAttemptCount: report.durableAttemptCount,
      observerStatus: report.observerStatus,
      recordedAt,
      caller: AttributedPrincipalV1Schema.parse({
        principalKind: 'service',
        principalId: 'exarchos.cutover-auto-export',
        role: 'cutover-exporter',
      }),
      authorization: AuthorizationSnapshotV1Schema.parse({
        authorizationId: 'cutover-auto-export:process',
        posture: 'read-only',
        capabilityIds: ['admission:cutover-export'],
        resolverVersion: '1.0',
        resolvedAt: recordedAt,
      }),
    });
    await config.store.append(
      ADMISSION_STREAM_ID,
      {
        type: ADMISSION_EVENT_TYPES.CUTOVER_READY,
        timestamp: recordedAt,
        source: CUTOVER_AUTO_EXPORT_SOURCE,
        data: { ...data },
      },
      { idempotencyKey: readinessId },
    );
    state.exported = true;
  } catch {
    state.failures += 1;
  }
}

function processLiveAttempts(): readonly LiveShadowAttempt[] {
  return liveShadowSink.liveAttempts();
}

function defaultNow(): string {
  return new Date().toISOString();
}
