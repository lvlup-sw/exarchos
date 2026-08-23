import { buildValidatedEvent } from '../../events/event-factory.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { workflowLogger } from '../../logger.js';
import { WORKFLOW_STATE_VIEW, type WorkflowStateView } from '../../projections/views/workflow-state-projection.js';
import { recordLiveTransition } from '../admission/live-shadow-observer.js';
import { buildCheckpointMeta, type CheckpointEnforcementConfig, incrementOperations, resetCounter, shouldEnforceCheckpoint } from '../checkpoint.js';
import { hsmTransitionGuard } from '../hsm-transition-guard.js';
import { allocatePhaseAttemptId, readPhaseAttemptId } from '../phase-attempt-id.js';
import { resolveGateSet } from '../phase-kind.js';
import { ErrorCode, WorkflowStateSchema } from '../schemas.js';
import { applyDotPath, hydrateEventsFromStore, readStateFile, StateStoreError, VersionConflictError, writeStateFile } from '../state-store.js';
import type { SetInput, WorkflowState } from '../types.js';
import { resolveBoundaryTouching, resolveRiskTier } from '../verification-policy-resolver.js';
import * as path from 'node:path';
import { CURRENT_ES_VERSION, isEventSourced, moduleViewMaterializer } from './shared.js';

// ─── handleSet ──────────────────────────────────────────────────────────────

const MAX_CAS_RETRIES = 3;

/**
 * Update fields and/or transition phase on a workflow state file.
 *
 * **Event-first contract:** When an event store is configured and a phase
 * transition occurs, the `workflow.transition` event is appended BEFORE
 * the state file is written. If the event append fails, no state is
 * modified and an error is returned. That event is keyed
 * `${featureId}:${evt.type}:${evt.from}:${evt.to}:${expectedVersion}`
 * (built in `hsm-transition-guard.ts`, which appends the suffix this
 * function passes as `idempotencyKeySuffix`).
 *
 * **ES v2 field updates:** For workflows with `_esVersion === 2`, field
 * updates emit a `state.patched` event with the patch delta before
 * writing. After the CAS write succeeds, the state file is overwritten
 * with a snapshot re-materialized from the full event stream, ensuring
 * the file is always a derived artifact. That event is keyed
 * `${featureId}:patch:${expectedVersion}:${fieldsHash}`, which guarantees
 * only **one event per (featureId, base-version, field-name-set)** — the
 * key covers field NAMES, not values, so two different patches to the same
 * fields at the same base version collide and the second is silently
 * dropped. Because `expectedVersion` is server-derived it also does NOT
 * deduplicate CAS or lost-response retries (those duplicate instead). The
 * full contract and its hazards are documented inline at the append site;
 * #1643 tracks the derivation fix. Do not rely on these keys for
 * end-to-end request idempotency.
 *
 * **Legacy v1 path:** Field-only updates write directly without events.
 *
 * **HSM single-path (DR-4, #1259):** Phase transitions route through the
 * shared `hsmTransitionGuard.attempt` primitive in the same code path the
 * canonical `handleTransition` handler uses. There is no second
 * phase-write surface — both action handlers converge on this primitive
 * for guard evaluation and event emission. The deprecated `set({phase})`
 * surface additionally emits `hsm.deprecated_action_invoked` for migration
 * telemetry; that emission is bolted on at the composite-handler boundary
 * (DR-4 acceptance criteria; T38 GREEN).
 */
export async function handleSet(
  input: SetInput,
  stateDir: string,
  eventStore: EventStore | null,
  options?: {
    skipPhases?: readonly string[];
    requiredReviews?: readonly string[];
    checkpoint?: CheckpointEnforcementConfig;
    /**
     * DR-1: resolved `.exarchos.yml workflow.maxPlanRevisions` cap. Injected
     * into the reserved ephemeral `state._maxPlanRevisions` for the pure
     * `revisionsExhausted` guard, then stripped before persistence — never
     * event-sourced (INV-1: a config threshold is not a fact).
     */
    maxPlanRevisions?: number;
    /**
     * DR-3: resolved `.exarchos.yml review.mutationEnforcement` mode and the
     * resolved mutation threshold. Injected (HIGH tier only) into
     * `_mutationEnforcement` / `_mutationThreshold` for the pure `allReviewsPassed`
     * score check, then stripped before persistence — never event-sourced (INV-1).
     */
    mutationEnforcement?: 'block' | 'advisory';
    mutationThreshold?: number;
    /**
     * DR-6: resolved NoCoverage budget for the pure `allReviewsPassed` guard's
     * SECOND, orthogonal axis. Injected (HIGH tier only) into `_maxNoCoverage`,
     * then stripped before persistence — never event-sourced (INV-1). Config
     * plumbing beside `_mutationThreshold`, not a facade fork: the pass-decision
     * lives in the guard, both facades reach it through this same injector.
     */
    maxNoCoverage?: number;
  },
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);
  // Retained across the CAS loop. A retry must re-use the identity already
  // committed by its first event-first pass, never mint a second attempt.
  let transitionPhaseAttemptId: string | undefined;

  for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
    let state: WorkflowState;
    try {
      state = await readStateFile(stateFile);
    } catch (err) {
      if (err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND) {
        return {
          success: false,
          error: {
            code: ErrorCode.STATE_NOT_FOUND,
            message: `State not found for feature: ${input.featureId}`,
          },
        };
      }
      throw err;
    }

    // ─── Checkpoint gate (DR-5): block phase transition when above threshold ──
    if (input.phase && options?.checkpoint) {
      const gateResult = shouldEnforceCheckpoint(
        state._checkpoint,
        options.checkpoint,
        'phase-transition',
      );

      // DR-10: emit checkpoint.state_missing event on graceful degradation.
      // Awaited so callers that query the stream immediately after this
      // handler returns observe the event (read-your-writes consistency).
      if (gateResult.warning === 'checkpoint-state-missing' && eventStore) {
        try {
          // #1325 — route through buildValidatedEvent for defense-in-depth
          // Zod validation. Emission is best-effort.
          const validatedEvent = buildValidatedEvent(input.featureId, 1, {
            type: 'checkpoint.state_missing' as import('../../events/schemas.js').EventType,
            correlationId: input.featureId,
            source: 'workflow',
            data: { action: 'set' },
          });
          await eventStore.appendValidated(input.featureId, validatedEvent);
        } catch {
          // Best-effort event emission — don't block the set() response
        }
      }

      if (gateResult.gated) {
        // DR-5: emit checkpoint.enforced event before returning gate response
        if (eventStore) {
          try {
            // #1325 — route through buildValidatedEvent for defense-in-depth
            // Zod validation. Emission is best-effort.
            const validatedEvent = buildValidatedEvent(input.featureId, 1, {
              type: 'checkpoint.enforced' as import('../../events/schemas.js').EventType,
              correlationId: input.featureId,
              source: 'workflow',
              data: {
                operationsSince: gateResult.operationsSince,
                threshold: gateResult.threshold,
                blockedAction: 'phase-transition',
              },
            });
            await eventStore.appendValidated(input.featureId, validatedEvent);
          } catch {
            // Best-effort event emission — don't block the gate response
          }
        }

        return {
          success: false,
          error: {
            code: 'CHECKPOINT_REQUIRED' as typeof ErrorCode[keyof typeof ErrorCode],
            message: `Checkpoint required before phase transition: ${gateResult.operationsSince} operations since last checkpoint (threshold: ${gateResult.threshold})`,
            ...(gateResult.gate !== undefined ? { gate: gateResult.gate } : {}),
            ...(gateResult.operationsSince !== undefined ? { operationsSince: gateResult.operationsSince } : {}),
            ...(gateResult.threshold !== undefined ? { threshold: gateResult.threshold } : {}),
          },
        };
      }
    }

    // Capture version for CAS
    const expectedVersion = state._version ?? 1;

    // Work with a deep copy to avoid shared reference mutation
    const mutableState = structuredClone(state) as Record<string, unknown>;

    // ─── Field updates (applied first so phase guards see new state) ───
    //
    // RESERVED_FIELD violations are detected by `applyDotPath`, which
    // throws a `StateStoreError` populated with structured `data`
    // (`{rejectedPath, rule, alternateWritePath}`). We catch it here so
    // the caller receives a structured error envelope rather than a
    // bare crash, and so the typed `data` block reaches the client.
    // Atomicity is preserved by `structuredClone`: `mutableState` is a
    // deep copy, so abandoning the loop mid-throw leaves the on-disk
    // state untouched (#1360).
    if (input.updates) {
      try {
        for (const [dotPath, value] of Object.entries(input.updates)) {
          applyDotPath(mutableState, dotPath, value);
        }
      } catch (err) {
        if (err instanceof StateStoreError && err.code === ErrorCode.RESERVED_FIELD) {
          return {
            success: false,
            error: {
              code: err.code,
              message: err.message,
              ...(err.data !== undefined ? { data: err.data } : {}),
            },
          };
        }
        throw err;
      }
    }

    // ─── Inject required reviews for guard evaluation ──────────────────
    // The allReviewsPassed guard reads _requiredReviews to enforce that
    // specific review dimensions exist (not just that present reviews pass).
    // Explicit config overrides workflow-type defaults.
    //
    // Presence check — NOT length — so an explicit empty array disables
    // required reviews for this transition. Treating `[]` as "not
    // provided" would silently fall back to defaults, contradicting the
    // caller's intent (CodeRabbit finding on PR #1076).
    //
    // Dimension names are owned by `review-contract.ts`, which is the
    // single source of truth shared with `playbooks.ts`. Do NOT hardcode
    // names here — changing the contract requires a one-line edit in
    // `review-contract.ts` so every consumer stays aligned (see #1073).
    if (input.phase) {
      if (options?.requiredReviews !== undefined) {
        // Explicit config (including explicit empty): use as-is
        mutableState._requiredReviews = options.requiredReviews;
      } else {
        const workflowType = state.workflowType as string;
        // ─── Tier-aware required reviews (R5 / verification ladder slice 3) ──
        // The high-tier `mutation-adequacy` adequacy backstop gates the
        // `/review` boundary for HIGH-risk workflows only (review-contract.ts
        // SoT — the dimension name is never literal here). The risk tier is
        // task-classification data from prepare_delegation; it reaches the
        // review-gate path only if a workflow-level tier is stamped on state.
        // Read it from the POST-update copy (`mutableState`), not the pre-update
        // `state`, so a tier set in THIS call's `updates` (e.g.
        // `{ phase:'review', updates:{ riskTier:'high' } }`) is honored — the
        // same "field updates applied first so phase guards see new state"
        // contract enforced above. We read defensively (the state schema is
        // `.passthrough()`), and fall back to the backward-compatible no-tier
        // roster when absent — exactly the pre-slice-3 behaviour.
        // `getRequiredReviews` ignores an unrecognised tier, so a malformed
        // stamp can never inject a dimension.
        // ─── DR-10 (T-14): monotonic, fail-safe tier resolution ────────────
        // Previously this collapsed an absent/malformed tier to the literal
        // `'low'` and hardcoded `boundaryTouching: false` — the two WEAKEST
        // ladder coordinates, asserted on no evidence. `resolveRiskTier`
        // returns `'unknown'` instead of fabricating a tier, and
        // `resolveBoundaryTouching` fails safe to `true`; `reviewRosterTier`
        // then projects `'unknown'` onto NO tier claim (`undefined`), which
        // yields the workflow-type base roster. That is materially different
        // from claiming `'low'`: it makes no positive assertion about blast
        // radius, and it cannot inject a tier-coupled dimension that no
        // producer will ever satisfy. The opposite projection —
        // `failSafeVerificationProfile` — governs which gates RUN, where the
        // hazard is under-verification rather than deadlock; see the resolver
        // module for why the two directions differ.
        const resolvedTier = resolveRiskTier(mutableState.riskTier);
        const boundaryTouching = resolveBoundaryTouching(mutableState.boundaryTouching);
        // DR-7: route the review roster through the single REVIEW gate-set
        // resolver — `resolveGateSet('REVIEW')`, the same resolver phase-entry
        // uses — instead of calling `getRequiredReviews` directly, so REVIEW
        // obligations have ONE source. The resolver owns the `'unknown'`
        // projection (see its comment): the roster makes no tier claim, while
        // the verification ladder escalates. `boundaryTouching` is unused by the
        // review resolver but is now RESOLVED rather than hardcoded `false`, so
        // no weakest-coordinate assertion survives anywhere on this path.
        const typeDefaults = resolveGateSet('REVIEW', {
          riskTier: resolvedTier,
          boundaryTouching,
          workflowType,
        }).flatMap((g) => (g.family === 'review' ? [g.gate] : []));
        if (typeDefaults.length) {
          mutableState._requiredReviews = typeDefaults;
        }
      }

      // ─── Inject plan-revision cap for guard evaluation (DR-1) ──────────
      // `revisionsExhausted` is a PURE guard and cannot read config, so the
      // resolved `.exarchos.yml workflow.maxPlanRevisions` cap is injected here
      // (as `_requiredReviews` is above) into a reserved ephemeral field the
      // guard reads. It is stripped before persistence below — the cap is a
      // config threshold, not a fact, so it never enters the event log (INV-1).
      // The sibling `workflow.maxFixCycles` is likewise a runtime-injected
      // override, never event-sourced. Absent injection the guard falls back to
      // its default (1) — the conservative, loop-terminating value.
      if (
        typeof options?.maxPlanRevisions === 'number' &&
        Number.isFinite(options.maxPlanRevisions)
      ) {
        mutableState._maxPlanRevisions = options.maxPlanRevisions;
      }

      // ─── Inject mutation score-enforcement mode + threshold (DR-3) ──────
      // `allReviewsPassed` is a PURE guard and cannot read config, so the
      // resolved `review.mutationEnforcement` mode + threshold are injected here
      // (as `_requiredReviews` / `_maxPlanRevisions` are). HIGH tier only —
      // low/medium never run mutation-adequacy, so the guard's score check stays
      // inert there. Advisory by default: with mode !== 'block' nothing is
      // injected, so the guard never enforces. Stripped before persistence below.
      if (resolveRiskTier(mutableState.riskTier) === 'high') {
        if (options?.mutationEnforcement !== undefined) {
          mutableState._mutationEnforcement = options.mutationEnforcement;
        }
        if (
          typeof options?.mutationThreshold === 'number' &&
          Number.isFinite(options.mutationThreshold)
        ) {
          mutableState._mutationThreshold = options.mutationThreshold;
        }
        // DR-6: the resolved NoCoverage budget for `allReviewsPassed` Check 4b's
        // orthogonal axis, injected exactly as the threshold above. Config
        // plumbing, not a facade fork — the pass-decision lives in the pure guard.
        // Only plumb a well-formed budget (non-negative integer) — a negative
        // or fractional value is rejected here rather than injected, matching
        // `resolveMaxNoCoverage` and the guard's NoCoverage-count check (INV-2).
        if (
          typeof options?.maxNoCoverage === 'number' &&
          Number.isInteger(options.maxNoCoverage) &&
          options.maxNoCoverage >= 0
        ) {
          mutableState._maxNoCoverage = options.maxNoCoverage;
        }
      }
    }

    // ─── Hydrate _events from event store for guard evaluation ──────────
    // Guards read state._events for transition prerequisites (e.g.,
    // teamDisbandedEmitted). Hydrate from the JSONL event store so all
    // event types — including team.spawned, team.disbanded, task.completed
    // — are visible to guards with full data spread.
    if (input.phase && eventStore) {
      try {
        mutableState._events = await hydrateEventsFromStore(
          input.featureId, eventStore,
        );
      } catch {
        // Best-effort: proceed with existing _events on query failure
        mutableState._events = mutableState._events ?? [];
      }
    } else if (input.phase && !eventStore) {
      workflowLogger.warn(
        { featureId: input.featureId },
        'eventStore unavailable during phase transition — _events will not be hydrated, guards may fail',
      );
    }

    // ─── Phase transition — routed through HSMTransitionGuard ──────────
    // The dispatch contract for guarded phase transitions is owned by the
    // `HSMTransitionGuard` primitive (see `hsm-transition-guard.ts` /
    // Primitive 3 in `docs/designs/archive/2026-05-06-v29-bug-cluster-combined-fix.md`).
    // It evaluates the composite guard, emits exactly one of
    // `workflow.transition` or `workflow.guard-failed` per attempt, and
    // returns a structured result. `handleSet` is now responsible only
    // for state mutation on success and CAS persistence — guard evaluation
    // and event emission live behind the primitive's interface.
    //
    // `pendingTransitionEventsCount` and `transitionTopSequence` are kept
    // so the post-transition path can update `_eventSequence` without
    // re-querying the event store.
    let pendingTransitionEventsCount = 0;
    let transitionTopSequence: number | undefined;

    if (input.phase) {
      const fromPhase = state.phase;
      if (fromPhase !== input.phase && transitionPhaseAttemptId === undefined) {
        transitionPhaseAttemptId = allocatePhaseAttemptId(
          input.featureId,
          fromPhase,
          input.phase,
          readPhaseAttemptId(state),
          expectedVersion,
        );
      }
      if (transitionPhaseAttemptId !== undefined) {
        // Internal workflow/dispatch context consumed by the HSM event emitter
        // and future proof producers. It is stripped after the decision; only
        // the active `phaseAttemptId` is persisted.
        mutableState._pendingPhaseAttemptId = transitionPhaseAttemptId;
      }
      let attemptResult;
      try {
        attemptResult = await hsmTransitionGuard.attempt(
          input.featureId,
          fromPhase,
          input.phase,
          {
            state: mutableState,
            // DR-10 (T-15): the PRE-update state. Field updates are applied to
            // `mutableState` above so phase guards see the new state, which for
            // the danger coordinate would let `updates: { riskTier: 'low' }`
            // weaken the very transition it accompanies. Passing the pre-update
            // state lets the primitive floor the coordinate monotonically — the
            // stamp still persists and governs later calls.
            priorState: state as unknown as Record<string, unknown>,
            workflowType: state.workflowType as string,
            skipPhases: options?.skipPhases,
            idempotencyKeySuffix: String(expectedVersion),
            eventStore,
            // ─── P07-02: live shadow observer (Transition tasks 027/051) ──
            // Feed the authoritative legacy transition outcome to the
            // evidence-backed admission engine, side by side, so the RESERVED
            // cutover gate can accumulate live evidence (>=20 attempts, all
            // phase kinds, both outcomes). This is the ONLY production wiring of
            // the P07-01 seam. It is behaviour-preserving for the AUTHORITATIVE
            // decision: the observer is error-isolated and cannot alter the
            // returned legacy result or any workflow event.
            //
            // DR-23 / T-31: `observerEventStore` is `GuardContext.eventStore`,
            // forwarded by the primitive. It is what makes the shadow evidence
            // durable (`admission.shadow-attempt` /
            // `admission.disagreement-disposition`) instead of a process-scoped
            // ring buffer. Enforcement does NOT flip here.
            shadowObserver: (observation, observerEventStore) =>
              recordLiveTransition(observation, mutableState, observerEventStore),
          },
        );
      } catch (err) {
        // Event-first contract: a thrown error from the primitive
        // means an event-store append failed (the only synchronous
        // failure mode on the success path). Surface it as
        // EVENT_APPEND_FAILED and abort the CAS write — state must
        // not advance past the unwritten event boundary.
        return {
          success: false,
          error: {
            code: ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      if (!attemptResult.ok) {
        if (attemptResult.reason === 'no-transition-defined') {
          return {
            success: false,
            error: {
              code: ErrorCode.INVALID_TRANSITION,
              message: attemptResult.errorMessage,
              ...(attemptResult.validTargets.length
                ? { validTargets: attemptResult.validTargets }
                : {}),
            },
          };
        }
        // reason === 'guard-failed' (CIRCUIT_OPEN / PHASE_BLOCKED preserved
        // as distinct codes rather than collapsed to GUARD_FAILED).
        const guardFailure = attemptResult.failures[0];
        const errorPayload: Record<string, unknown> = {
          code:
            attemptResult.errorCode === 'CIRCUIT_OPEN'
              ? ErrorCode.CIRCUIT_OPEN
              : attemptResult.errorCode === 'PHASE_BLOCKED'
                ? ErrorCode.PHASE_BLOCKED
                : ErrorCode.GUARD_FAILED,
          message: attemptResult.errorMessage,
        };
        if (guardFailure?.expectedShape) {
          errorPayload.expectedShape = guardFailure.expectedShape;
        }
        if (guardFailure?.suggestedFix) {
          errorPayload.suggestedFix = guardFailure.suggestedFix;
        }
        return {
          success: false,
          error: errorPayload as NonNullable<ToolResult['error']>,
        };
      }

      // ok: true — apply state mutation. Idempotent attempts are no-ops.
      //
      // INV-5b (T73 / CR #13): a no-op self-transition must be a no-op
      // end-to-end — no state mutation, no event emission, no version
      // bump, no `updatedAt` rewrite, no checkpoint counter increment.
      // The HSM guard already short-circuits event emission upstream
      // (see DefaultHSMTransitionGuard.attempt's idempotency branch);
      // without this early-return `handleSet` would fall through to the
      // checkpoint counter increment + `updatedAt` write + CAS persistence
      // below, mutating `_version`, `updatedAt`, `_checkpoint.operations`,
      // and `_checkpoint.lastActivityTimestamp` despite the guard's
      // promise that nothing happened. Returning here also surfaces an
      // explicit `idempotent: true` discriminator on the response so
      // callers can distinguish a real transition from a no-op
      // acknowledgement without inspecting events. Gated on `!input.updates`
      // so a hypothetical caller passing `{ phase, updates }` together
      // still gets the field-only path; today's callers (handleTransition
      // → applyTransition) never combine the two.
      if (attemptResult.idempotent && !input.updates) {
        return {
          success: true,
          data: {
            phase: state.phase,
            updatedAt: state.updatedAt,
            idempotent: true,
            phaseAttemptId: readPhaseAttemptId(state),
          },
          _meta: buildCheckpointMeta(state._checkpoint),
        };
      }

      if (!attemptResult.idempotent) {
        mutableState.phase = attemptResult.newPhase;
        mutableState.phaseAttemptId = transitionPhaseAttemptId;

        if (Object.keys(attemptResult.historyUpdates).length > 0) {
          const history = {
            ...(mutableState._history as Record<string, string>),
          };
          for (const [key, value] of Object.entries(
            attemptResult.historyUpdates,
          )) {
            history[key] = value;
          }
          mutableState._history = history;
        }

        // Reset checkpoint counter on phase transition.
        mutableState._checkpoint = resetCounter(
          mutableState._checkpoint as WorkflowState['_checkpoint'],
          attemptResult.newPhase,
        );

        pendingTransitionEventsCount = attemptResult.emittedEvents.length;
        if (attemptResult.transitionEvent.sequence > 0) {
          transitionTopSequence = attemptResult.transitionEvent.sequence;
        }
      }

      // Clean up transient guard-evaluation fields — not persisted to state
      // (INV-1: the injected config cap is not a fact and must not be folded).
      delete mutableState._requiredReviews;
      delete mutableState._maxPlanRevisions;
      delete mutableState._mutationEnforcement;
      delete mutableState._mutationThreshold;
      delete mutableState._maxNoCoverage;
      delete mutableState._pendingPhaseAttemptId;
    }

    // Transition events are now emitted inside `hsmTransitionGuard.attempt`
    // — see Primitive 3 in `docs/designs/archive/2026-05-06-v29-bug-cluster-combined-fix.md`.
    //
    // ─── Idempotency contract for the `state.patched` append below ───
    //
    // The real guarantee is narrow: **at most one `state.patched` event per
    // (featureId, base-version, field-name-set)**. That is the whole of it.
    //
    // Why: the key at the append site is
    //   `${featureId}:patch:${expectedVersion}:${fieldsHash}`
    // and `fieldsHash` is `[...updateKeys].sort().join(',')` over
    // `Object.keys(input.updates)` — sorted field *NAMES* only. Values never
    // enter the key. (`fieldsHash` is also a plain join, NOT a hash; the name
    // is misleading — do not read it as a digest of the patch.)
    //
    // Two consequences, and they cut in opposite directions:
    //
    // 1. COLLISION (lost write). `{status:'a'}` and `{status:'b'}` applied at
    //    the same base version derive the IDENTICAL key. The second append is
    //    silently deduplicated by the event store — the write is dropped, with
    //    no error surfaced to the caller. Distinct patches are conflated
    //    because only the key set is keyed on.
    //
    // 2. NO DEDUP ACROSS RETRIES. `expectedVersion` is server-derived
    //    (`state._version ?? 1`, re-read from disk on every pass of this
    //    loop). So it is not stable across exactly the retries a dedup key
    //    exists to cover:
    //      - CAS retry: a `VersionConflictError` means a concurrent writer
    //        advanced `_version`, so the next pass reads a NEW version and
    //        derives a DIFFERENT key. The prior pass's event is already in the
    //        store (event-first), so the retry ADDS a second event rather than
    //        collapsing onto the first.
    //      - Lost-response retry: a client that re-sends after a dropped
    //        response has its `expectedVersion` re-derived from the server's
    //        own already-advanced version — again a different key, again a
    //        duplicate.
    //
    // Net: this key drops writes it should keep (1) and duplicates writes it
    // should collapse (2). Fixing the derivation is tracked in #1643 — do not
    // infer a stronger contract than the one stated above until it lands.
    //
    // SCOPE: everything above describes ONLY the `state.patched` append in
    // this function. It does NOT cover the transition path at the
    // `hsmTransitionGuard.attempt` call above, which passes
    // `idempotencyKeySuffix: String(expectedVersion)` and keys a DIFFERENT
    // event type (`workflow.transition` and its compound/fix-cycle siblings)
    // via a different derivation built inside the guard
    // (`${featureId}:${evt.type}:${evt.from}:${evt.to}:${suffix}`, see
    // `hsm-transition-guard.ts`). Do not assume this analysis transfers to it.
    let highestEventSequence: number | undefined = transitionTopSequence;

    // ─── Event-first: append state.patched event for v2 field updates ──
    const updateKeys = input.updates ? Object.keys(input.updates) : [];
    // Reject a state the file write would refuse BEFORE appending
    // `state.patched`. Event-first plus a name-only idempotency key
    // otherwise leaves a ghost row that shadows the next distinct
    // patch at the same version, so post-dispatch observation cannot
    // see the write that actually landed.
    if (updateKeys.length > 0) {
      const currentVersion =
        typeof mutableState._version === 'number' ? mutableState._version : 1;
      const candidate = { ...mutableState, _version: currentVersion + 1 };
      const validation = WorkflowStateSchema.safeParse(candidate);
      if (!validation.success) {
        return {
          success: false,
          error: {
            code: ErrorCode.INVALID_INPUT,
            message: `Write-time validation failed: ${validation.error.message}`,
          },
        };
      }
    }
    if (
      isEventSourced(state)
      && eventStore
      && updateKeys.length > 0
    ) {
      try {
        const fieldsHash = [...updateKeys].sort().join(',');
        const idempotencyKey = `${input.featureId}:patch:${expectedVersion}:${fieldsHash}`;
        // #1325 — route through buildValidatedEvent for defense-in-depth
        // Zod validation at the emission boundary.
        const validatedEvent = buildValidatedEvent(input.featureId, 1, {
          type: 'state.patched' as import('../../events/schemas.js').EventType,
          correlationId: input.featureId,
          source: 'workflow',
          data: {
            featureId: input.featureId,
            fields: updateKeys,
            patch: input.updates,
          },
        });
        const event = await eventStore.appendValidated(input.featureId, validatedEvent, { idempotencyKey });

        highestEventSequence = Math.max(highestEventSequence ?? 0, event.sequence);
      } catch (err) {
        // Event-first: if event append fails, do NOT update state
        return {
          success: false,
          error: {
            code: ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }

    // Update _eventSequence when any events were appended
    if (highestEventSequence !== undefined) {
      mutableState._eventSequence = highestEventSequence;
    }

    // Increment checkpoint operation counter
    mutableState._checkpoint = incrementOperations(
      mutableState._checkpoint as WorkflowState['_checkpoint'],
    );

    // Update timestamp
    mutableState.updatedAt = new Date().toISOString();

    // Update lastActivityTimestamp on checkpoint
    const checkpoint = mutableState._checkpoint as Record<string, unknown>;
    checkpoint.lastActivityTimestamp = new Date().toISOString();

    // Write back to disk with CAS protection + schema validation
    try {
      await writeStateFile(stateFile, mutableState as WorkflowState, { expectedVersion });
      // writeStateFile increments _version on disk; sync mutableState to match
      (mutableState as Record<string, unknown>)._version = expectedVersion + 1;
    } catch (err) {
      // Validation failure — return structured error instead of corrupting state
      if (err instanceof StateStoreError && err.code === ErrorCode.INVALID_INPUT) {
        return {
          success: false,
          error: {
            code: ErrorCode.INVALID_INPUT,
            message: err.message,
          },
        };
      }
      if (err instanceof VersionConflictError && attempt < MAX_CAS_RETRIES) {
        // Re-read and retry on version conflict.
        //
        // NOTE: the next iteration's append is NOT deduplicated against this
        // failed pass's event. A `VersionConflictError` means a concurrent
        // writer advanced `_version`, so the re-read derives a new
        // `expectedVersion` and therefore a new idempotency key — while this
        // pass's event is already committed (event-first). The retry appends
        // an ADDITIONAL event. See the idempotency contract above the
        // `state.patched` append for the full derivation; #1643 tracks the
        // fix.
        continue;
      }

      // CAS exhaustion: emit diagnostic event before throwing
      if (err instanceof VersionConflictError && eventStore) {
        try {
          // #1325 — route through buildValidatedEvent for defense-in-depth
          // Zod validation. Add correlationId / source consistent with
          // the canonical pattern used by every other emission in this
          // handler. Emission is best-effort.
          const validatedEvent = buildValidatedEvent(input.featureId, 1, {
            type: 'workflow.cas-failed' as import('../../events/schemas.js').EventType,
            correlationId: input.featureId,
            source: 'workflow',
            data: {
              featureId: input.featureId,
              phase: input.phase ?? (mutableState.phase as string) ?? 'unknown',
              retries: MAX_CAS_RETRIES,
            },
          });
          await eventStore.appendValidated(input.featureId, validatedEvent);
        } catch {
          // Best-effort diagnostic emission — don't mask the actual CAS error
        }
      }

      throw err;
    }

    // ─── Re-materialize state from events for v2 workflows ──────────
    // After the CAS write succeeds, overwrite the state file with a
    // snapshot derived from the full event stream. This ensures the
    // state file is always a derived artifact of the event log.
    if (
      isEventSourced(state)
      && eventStore
      && moduleViewMaterializer
    ) {
      const allEvents = await eventStore.query(input.featureId);
      const materialized = moduleViewMaterializer.materialize<WorkflowStateView>(
        input.featureId,
        WORKFLOW_STATE_VIEW,
        allEvents,
      );

      // Merge materialized state with checkpoint/version metadata from the
      // mutable state (checkpoint tracking is not event-sourced)
      const latestSequence = allEvents.length
        ? allEvents[allEvents.length - 1]?.sequence
        : mutableState._eventSequence;
      const snapshot = {
        ...(materialized as unknown as Record<string, unknown>),
        _version: (mutableState._version as number),
        _eventSequence: latestSequence,
        _esVersion: CURRENT_ES_VERSION,
        _checkpoint: mutableState._checkpoint,
        updatedAt: mutableState.updatedAt,
      };

      try {
        await writeStateFile(
          stateFile,
          snapshot as unknown as WorkflowState,
          { expectedVersion: mutableState._version as number, skipValidation: true },
        );
      } catch (err) {
        if (err instanceof VersionConflictError) {
          // Another writer updated the state after our CAS write; skip rematerialization
        } else {
          throw err;
        }
      }
    }

    // Event-first: events already appended before CAS write with idempotency keys.
    // State write is the follow-up materialization step.
    //
    // v2.11 Phase 1: sidecar fallback (#1082) removed; no `sidecarPending`
    // envelope marker needed.
    //
    // Surface `workflowType` so `nextActionsFromResult` (called by
    // `envelopeWrap` in composite.ts) can compute HATEOAS links — the
    // helper requires both `phase` AND `workflowType` to look up the HSM.
    // Without it, every successful `transition` would ship an empty
    // `next_actions` array. Field is purely additive.
    return {
      success: true,
      data: {
        phase: mutableState.phase as string,
        workflowType: mutableState.workflowType as string,
        updatedAt: mutableState.updatedAt as string,
        phaseAttemptId: mutableState.phaseAttemptId as string,
      },
      _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
    };
  }

  // Should not be reached, but satisfy TypeScript
  throw new StateStoreError(
    ErrorCode.VERSION_CONFLICT,
    `Concurrent write conflict: failed to acquire consistent version after ${MAX_CAS_RETRIES} retries for feature: ${input.featureId}, phase: ${input.phase ?? 'field-update'}`,
  );
}
