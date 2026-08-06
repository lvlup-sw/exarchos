// ─── #1739 — cutover readiness auto-export ───────────────────────────────────
//
// The promotion path's "you are ready" moment should not depend on an operator
// remembering to poll `cutover_readiness`. This module hooks the observer's
// DURABLE-APPEND SUCCESS path (`setDurableAppendSuccessListener` — a listener
// seam, because the observer cannot import the gate without a runtime cycle)
// and, when all six conditions are satisfied for the FIRST time:
//
//   1. atomically writes the full report to
//      `<stateDir>/admission/cutover-readiness.json` (atomicWriteFile — fsync'd
//      temp + rename publish), and
//   2. appends ONE registered `admission.cutover-ready` fact to the reserved
//      `exarchos-admission` stream, keyed on a DETERMINISTIC idempotency key
//      derived from store identity (`cutover-ready:sha256(stateDir)`) — never
//      clock- or random-derived (the T-49 lesson), so a repeat evaluation after
//      readiness (or a post-restart re-fire) collapses onto the stored row.
//
// Cost discipline: a cheap IN-MEMORY pre-filter runs first — the observer
// health counter must have seen at least MINIMUM_LIVE_ATTEMPTS attempts before
// the durable reader is touched at all. Below threshold the hook is O(1) and
// store-free.
//
// Failure discipline: the hook MUST NOT throw into the transition path. Every
// failure is COUNTED (`cutoverAutoExportDiagnostics().failures`) and swallowed;
// the next durable-append success simply retries. The observer's listener call
// site is additionally try/catch-wrapped — defence in depth.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { ADMISSION_STREAM_ID } from '../../core/infra-streams.js';
import { AdmissionCutoverReadyData } from '../../event-store/schemas.js';
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

// ─── Configuration ────────────────────────────────────────────────────────────

/** One local store, readable (enumeration + query) AND appendable. */
export interface CutoverAutoExportStore extends ShadowEvidenceSource {
  append: ShadowEvidenceAppender['append'];
}

export interface CutoverAutoExportConfig {
  readonly store: CutoverAutoExportStore;
  /** The store's state directory — both the export root and the identity input. */
  readonly stateDir: string;
  /** Live-attempt source; defaults to the process-level {@link liveShadowSink}. */
  readonly liveAttempts?: () => readonly LiveShadowAttempt[];
  /** Health source; defaults to the process-level {@link liveShadowHealth}. */
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
 * The deterministic first-readiness identity for one store: a pure function of
 * store identity (the stateDir path), NOTHING wall-clock and NOTHING random —
 * so every process, restart, and retry that reaches readiness over the same
 * store derives the same key and the append dedupes (INV-8 / T-49).
 */
export function cutoverReadinessIdempotencyKey(stateDir: string): string {
  const digest = createHash('sha256').update(stateDir, 'utf8').digest('hex');
  return `cutover-ready:${digest}`;
}

// ─── Module state (process-level, mirroring the observer's own wiring) ───────

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
 * Install (or, with `undefined`, tear down) the auto-export wiring: stores the
 * config, resets the first-time latch and counters, and registers
 * {@link maybeExportCutoverReadiness} for the observer's durable-append
 * success seam. Called from lifecycle wiring (`core/context.ts`) with the real
 * EventStore + stateDir; tests call it with fakes and tear down after.
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

// ─── The hook ─────────────────────────────────────────────────────────────────

/**
 * The durable-append success hook. Synchronous entry (the observer's
 * settlement chain must not await it); the full evaluation runs on a tracked
 * single-flight promise. Total: never throws.
 */
export function maybeExportCutoverReadiness(): void {
  const config = state.config;
  if (config === undefined || state.exported) return;

  // Cheap in-memory pre-filter (#1739): below the live-attempt threshold the
  // gate CANNOT be satisfied (`live-attempt-threshold` needs >= MINIMUM
  // comparable attempts, and comparable <= observed), so the durable reader is
  // never touched.
  const health = (config.observerHealth ?? processObserverHealth)();
  if (health.attemptsObserved < MINIMUM_LIVE_ATTEMPTS) return;

  if (state.inFlight !== undefined) return; // single flight
  const run = runExport(config, health).then(
    () => undefined,
    () => {
      // runExport already counts its own failures; this arm only guarantees
      // the in-flight promise can never reject into an unhandled rejection.
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
    // Counted, never thrown: a failed export must not block (or even be
    // visible to) the transition whose durable append triggered it.
    state.failures += 1;
  }
}

function processLiveAttempts(): readonly LiveShadowAttempt[] {
  return liveShadowSink.liveAttempts();
}

function defaultNow(): string {
  return new Date().toISOString();
}
