import { isPlainObject } from './state-mutation.js';

export interface GuardFailure {
  readonly passed: false;
  readonly reason: string;
  readonly expectedShape?: Record<string, unknown>;
  readonly suggestedFix?: {
    readonly tool: string;
    readonly params: Record<string, unknown>;
  };
}

export type GuardResult = true | GuardFailure;

export interface Guard {
  readonly id: string;
  readonly evaluate: (state: Record<string, unknown>) => GuardResult;
  readonly description: string;
  /** True for guards defined in custom workflow configs (async shell execution). */
  readonly custom?: boolean;
}

/**
 * Compose multiple guards into a single guard that requires all to pass.
 * Returns the first failure encountered, or true if all pass.
 */
export function composeGuards(id: string, description: string, ...innerGuards: Guard[]): Guard {
  return {
    id,
    description,
    evaluate: (state: Record<string, unknown>): GuardResult => {
      for (const guard of innerGuards) {
        const result = guard.evaluate(state);
        if (result !== true) return result;
      }
      return true;
    },
  };
}

/**
 * Read a nested object field from untyped workflow state. The reader narrows the value
 * with `isPlainObject` and does not assert its type. A string, number, array, or `null`
 * gives the same `undefined` as a missing field, so a malformed field takes the branch of
 * a missing field.
 */
function readObjectField(
  state: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = state[field];
  return isPlainObject(value) ? value : undefined;
}

/**
 * Read a field that holds a list of records, such as `state._events`. A field that is
 * not an array gives an empty list, and entries that are not records drop out.
 */
function readRecordArrayField(
  state: Record<string, unknown>,
  field: string,
): readonly Record<string, unknown>[] {
  const value = state[field];
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

/** Read a string property from a value of unknown shape, or give `undefined`. */
function readStringField(value: unknown, field: string): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const raw = value[field];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * A typed artifact reference: a non-blank string that holds a path, a URL, or the
 * artifact contents. Each other value refers to nothing.
 *
 * Consumers that can import this module, such as the delegation-readiness view,
 * must share this predicate. The admission algebra in
 * `admission/legacy-state-translation.ts` must not import this module, so it keeps a
 * duplicate. `legacy-guard-parity.test.ts` keeps the two in lockstep.
 */
export function isTypedArtifactReference(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Build a guard that requires a typed artifact reference at `artifacts[field]` or at
 * the top-level `field`. A bare boolean, an object, or a blank string is not an
 * artifact. Both reads are narrowed, because a loose fallback is an open bypass.
 */
function makeArtifactGuard(field: string, description: string, customId?: string): Guard {
  const id = customId ?? `${field}-artifact-exists`;
  return {
    id,
    description,
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const artifacts = readObjectField(state, 'artifacts');
      if (artifacts != null && isTypedArtifactReference(artifacts[field])) return true;
      if (isTypedArtifactReference(state[field])) return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason:
          `${id} not satisfied: artifacts.${field} must be a non-empty string ` +
          `(a path or the artifact contents), not a bare boolean/object/whitespace`,
        expectedShape: { artifacts: { [field]: '<path-or-content>' } },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: {
            action: 'update',
            featureId,
            updates: { artifacts: { [field]: '<path-or-content>' } },
          },
        },
      };
    },
  };
}

export const PASSED_STATUSES = new Set(['pass', 'passed', 'approved', 'fixes-applied']);
export const FAILED_STATUSES = new Set(['fail', 'failed', 'needs_fixes']);

/** Review expectedShape constant used by multiple guards. */
const REVIEW_EXPECTED_SHAPE: Record<string, unknown> = {
  reviews: { '<name>': { status: 'pass (or verdict: "pass")' } },
};

/**
 * Extract the review status from an entry. The reader checks `status` first, then
 * `verdict` as a synonym. Values are lowercased, so an uppercase verdict such as
 * `"PASS"` matches `PASSED_STATUSES` and `FAILED_STATUSES`.
 */
function extractStatus(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.status === 'string') return entry.status.toLowerCase();
  if (typeof entry.verdict === 'string') return entry.verdict.toLowerCase();
  return undefined;
}

/**
 * Collect each review status from a reviews object. An entry is flat, with `status`
 * or `verdict`, or nested one level, as in `reviews.A1.specReview.status`. The legacy
 * `passed: boolean` shape also counts. An entry that is not a plain object is skipped.
 */
export function collectReviewStatuses(
  reviews: Record<string, unknown>,
): Array<{ path: string; status: string }> {
  const results: Array<{ path: string; status: string }> = [];
  for (const [key, entry] of Object.entries(reviews)) {
    if (!isPlainObject(entry)) continue;
    const status = extractStatus(entry);
    if (status !== undefined) {
      results.push({ path: key, status });
    } else if (typeof entry.passed === 'boolean') {
      results.push({ path: key, status: entry.passed ? 'passed' : 'failed' });
    } else {
      for (const [subKey, sub] of Object.entries(entry)) {
        if (!isPlainObject(sub)) continue;
        const subStatus = extractStatus(sub);
        if (subStatus !== undefined) {
          results.push({ path: `${key}.${subKey}`, status: subStatus });
        } else if (typeof sub.passed === 'boolean') {
          results.push({ path: `${key}.${subKey}`, status: sub.passed ? 'passed' : 'failed' });
        }
      }
    }
  }
  return results;
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * A fresh record without a prototype. `Object.create(null)` returns `any`, so the
 * return annotation pins the type.
 */
function emptyRecord(): Record<string, unknown> {
  return Object.create(null);
}

/**
 * Build an `expectedShape` that sets `{ status: 'pass' }` at each failed path. A
 * dotted path such as `A1.specReview` becomes nested objects. Unsafe keys are skipped.
 */
function buildFailedReviewsExpectedShape(
  notPassed: Array<{ path: string; status: string }>,
): { reviews: Record<string, unknown> } {
  const reviewEntries = emptyRecord();
  for (const s of notPassed) {
    const parts = s.path.split('.');
    let cursor: Record<string, unknown> = reviewEntries;
    let skip = false;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (key === undefined || UNSAFE_KEYS.has(key)) { skip = true; break; }
      const existing = cursor[key];
      const branch = isPlainObject(existing) ? existing : emptyRecord();
      cursor[key] = branch;
      cursor = branch;
    }
    if (skip) continue;
    const leafKey = parts[parts.length - 1];
    if (leafKey !== undefined && !UNSAFE_KEYS.has(leafKey)) {
      cursor[leafKey] = { status: 'pass' };
    }
  }
  return { reviews: reviewEntries };
}

/**
 * The plan-revision cap when `.exarchos.yml` injects no `state._maxPlanRevisions`.
 * One revise cycle runs, then the workflow escalates.
 */
export const DEFAULT_MAX_PLAN_REVISIONS = 1;
const MAX_SYNTHESIZE_RETRIES = 3;

/**
 * Tell if `state._events` holds a `synthesize.requested` event. `synthesisOptedIn` and
 * `synthesisOptedOut` both call it. Each guard keeps its own branch logic, so a change
 * to one cannot skew the other.
 */
function hasSynthesizeRequestEvent(state: Record<string, unknown>): boolean {
  const events = readRecordArrayField(state, '_events');
  return events.some((e) => e.type === 'synthesize.requested');
}

/** Read `state.oneshot.synthesisPolicy`. A missing or unknown value gives `on-request`. */
function readSynthesisPolicy(state: Record<string, unknown>): 'always' | 'never' | 'on-request' {
  const oneshot = readObjectField(state, 'oneshot');
  const raw = oneshot?.synthesisPolicy;
  if (raw === 'always' || raw === 'never' || raw === 'on-request') return raw;
  return 'on-request';
}

export const guards = {
  designArtifactExists: makeArtifactGuard('design', 'Design artifact must exist'),

  planArtifactExists: makeArtifactGuard('plan', 'Plan artifact must exist'),

  /**
   * Pass when each task has the status `complete`. An absent task list passes. A
   * present `tasks` value that is not an array fails, so corrupt state never reads as done.
   */
  allTasksComplete: {
    id: 'all-tasks-complete',
    description: 'All tasks must be complete',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const rawTasks = state.tasks;
      if (rawTasks == null) return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      if (!Array.isArray(rawTasks)) {
        return {
          passed: false,
          reason:
            `all-tasks-complete not satisfied: state.tasks must be an array of tasks ` +
            `(got ${typeof rawTasks}) — task completion cannot be verified`,
          expectedShape: { tasks: [{ id: '<task-id>', status: 'complete' }] },
        };
      }
      const tasks: readonly unknown[] = rawTasks;
      if (tasks.length === 0) return true;
      const incomplete = tasks.filter((t) => readStringField(t, 'status') !== 'complete');
      if (incomplete.length === 0) return true;
      return {
        passed: false,
        reason: `all-tasks-complete not satisfied: ${incomplete.length} task(s) incomplete`,
        expectedShape: { tasks: [{ id: '<task-id>', status: 'complete' }] },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: {
            action: 'update',
            featureId,
            updates: {
              tasks: incomplete.map((t) => ({
                id: readStringField(t, 'id') ?? '<task-id>',
                status: 'complete',
              })),
            },
          },
        },
      };
    },
  },

  /**
   * Pass when each required review dimension is present and each review entry passes.
   * The guard collects the failures into one result, so one retry can fix them. A
   * required key that is not a string, is unsafe, or has no recognizable status counts
   * as missing. The fix payload skips unsafe keys to prevent prototype pollution.
   *
   * The mutation checks read injected values, never the project config. In `block`
   * mode, a degraded run, a non-finite score, or a score below `_mutationThreshold`
   * fails. A skipped run stays advisory. For a scored run, an unreadable NoCoverage
   * count or a count above `_maxNoCoverage` fails.
   */
  allReviewsPassed: {
    id: 'all-reviews-passed',
    description: 'All required reviews must be present and have passed',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const reviews = readObjectField(state, 'reviews');
      if (!reviews) {
        return {
          passed: false,
          reason:
            'state.reviews is missing — set reviews.{name} with status: "pass" or "approved"',
          expectedShape: REVIEW_EXPECTED_SHAPE,
        };
      }

      const featureId = typeof state.featureId === 'string' ? state.featureId : '<featureId>';
      const reasons: string[] = [];
      const expectedReviews: Record<string, unknown> = {};
      const suggestedUpdates: Record<string, unknown> = {};

      const requiredReviews: readonly unknown[] = Array.isArray(state._requiredReviews)
        ? state._requiredReviews
        : [];
      const missing: string[] = [];
      if (requiredReviews.length > 0) {
        for (const rawKey of requiredReviews) {
          if (typeof rawKey !== 'string' || UNSAFE_KEYS.has(rawKey)) {
            missing.push(String(rawKey));
            continue;
          }
          const key = rawKey;
          if (!Object.prototype.hasOwnProperty.call(reviews, key)) {
            missing.push(key);
            continue;
          }
          const entry = reviews[key];
          if (!isPlainObject(entry)) {
            missing.push(key);
            continue;
          }
          const hasStatus = extractStatus(entry) !== undefined;
          const hasLegacyPassed = typeof entry.passed === 'boolean';
          if (!hasStatus && !hasLegacyPassed) {
            missing.push(key);
          }
        }
        if (missing.length > 0) {
          reasons.push(
            `Missing required review dimensions: ${missing.join(', ')}. Run the review skills for these dimensions before transitioning.`,
          );
          for (const key of missing) {
            if (UNSAFE_KEYS.has(key)) continue;
            expectedReviews[key] = { status: 'pass' };
            suggestedUpdates[`reviews.${key}.status`] = 'pass';
          }
        }
      }

      const statuses = collectReviewStatuses(reviews);
      if (statuses.length === 0) {
        if (missing.length === 0) {
          return {
            passed: false,
            reason:
              'state.reviews has no recognizable review entries — each review needs a status field ("pass", "approved", "fail", "needs_fixes")',
            expectedShape: REVIEW_EXPECTED_SHAPE,
          };
        }
      }

      const notPassed = statuses.filter((s) => !PASSED_STATUSES.has(s.status));
      if (notPassed.length > 0) {
        reasons.push(
          `Reviews not passed: ${notPassed.map((s) => `${s.path} (status: "${s.status}")`).join(', ')}`,
        );
        const failedShape = buildFailedReviewsExpectedShape(notPassed).reviews;
        for (const [k, v] of Object.entries(failedShape)) {
          expectedReviews[k] = v;
        }
        for (const s of notPassed) {
          const segments = s.path.split('.');
          if (segments.some((seg) => UNSAFE_KEYS.has(seg))) continue;
          suggestedUpdates[`reviews.${s.path}.status`] = 'pass';
        }
      }

      if (
        state._mutationEnforcement === 'block' &&
        typeof state._mutationThreshold === 'number' &&
        Number.isFinite(state._mutationThreshold)
      ) {
        const dim = readObjectField(reviews, 'mutation-adequacy');
        if (dim?.degraded === true) {
          reasons.push(
            `mutation-adequacy gate degraded (runner failed or emitted an unparseable ` +
              `report) and produced no verifiable score (review.mutationEnforcement: block)`,
          );
        } else {
          const score = dim?.mutationScore;
          if (dim && dim.skipped !== true && typeof score === 'number') {
            if (!Number.isFinite(score)) {
              reasons.push(
                `mutation-adequacy produced a non-finite score (unverifiable) ` +
                  `(review.mutationEnforcement: block)`,
              );
            } else if (score < (state._mutationThreshold as number)) {
              reasons.push(
                `mutation-adequacy score ${score} is below the enforced threshold ` +
                  `${state._mutationThreshold} (review.mutationEnforcement: block)`,
              );
            }
          }
        }
      }

      if (
        state._mutationEnforcement === 'block' &&
        typeof state._maxNoCoverage === 'number' &&
        Number.isInteger(state._maxNoCoverage) &&
        state._maxNoCoverage >= 0
      ) {
        const maxNoCoverage = state._maxNoCoverage;
        const dim = readObjectField(reviews, 'mutation-adequacy');
        if (dim && dim.skipped !== true && dim.degraded !== true) {
          const noCoverage = dim.noCoverage;
          if (typeof noCoverage !== 'number' || !Number.isInteger(noCoverage) || noCoverage < 0) {
            reasons.push(
              `mutation-adequacy produced no verifiable NoCoverage count ` +
                `(review.mutationEnforcement: block)`,
            );
          } else if (noCoverage > maxNoCoverage) {
            reasons.push(
              `mutation-adequacy has ${noCoverage} uncovered (NoCoverage) mutant(s), ` +
                `exceeding the enforced budget of ${state._maxNoCoverage} ` +
                `(review.mutationEnforcement: block)`,
            );
          }
        }
      }

      if (reasons.length === 0) return true;

      return {
        passed: false,
        reason: reasons.join(' | '),
        expectedShape: { reviews: expectedReviews },
        ...(Object.keys(suggestedUpdates).length > 0
          ? {
              suggestedFix: {
                tool: 'exarchos_workflow',
                params: { action: 'update', featureId, updates: suggestedUpdates },
              },
            }
          : {}),
      };
    },
  },

  anyReviewFailed: {
    id: 'any-review-failed',
    description: 'At least one review must have failed',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const reviews = readObjectField(state, 'reviews');
      if (!reviews) {
        return {
          passed: false,
          reason: 'state.reviews is missing — cannot determine if any review failed',
          expectedShape: REVIEW_EXPECTED_SHAPE,
        };
      }
      const statuses = collectReviewStatuses(reviews);
      if (statuses.length === 0) {
        return {
          passed: false,
          reason: 'state.reviews has no recognizable review entries',
          expectedShape: REVIEW_EXPECTED_SHAPE,
        };
      }
      const hasFailed = statuses.some((s) => FAILED_STATUSES.has(s.status));
      if (!hasFailed) {
        return {
          passed: false,
          reason: `No failed reviews found: ${statuses.map((s) => `${s.path} (status: "${s.status}")`).join(', ')}`,
        };
      }
      return true;
    },
  },

  prUrlExists: {
    id: 'pr-url-exists',
    description: 'PR URL must exist',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const synthesis = readObjectField(state, 'synthesis');
      if (synthesis?.prUrl != null) return true;
      const artifacts = readObjectField(state, 'artifacts');
      if (artifacts?.pr != null) return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: 'pr-url-exists not satisfied: synthesis.prUrl or artifacts.pr must be set',
        expectedShape: { synthesis: { prUrl: '<pr-url>' } },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'update', featureId, updates: { synthesis: { prUrl: '<pr-url>' } } },
        },
      };
    },
  },

  humanUnblocked: {
    id: 'human-unblocked',
    description: 'Human must have unblocked the workflow',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      if (state.unblocked === true) return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: 'human-unblocked not satisfied: set state.unblocked to true',
        expectedShape: { unblocked: true },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'update', featureId, updates: { unblocked: true } },
        },
      };
    },
  },

  triageComplete: {
    id: 'triage-complete',
    description: 'Triage must be complete',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const triage = readObjectField(state, 'triage');
      if (triage != null && triage.symptom != null) return true;
      return {
        passed: false,
        reason: 'triage-complete not satisfied',
        expectedShape: { triage: { symptom: '<description>' } },
      };
    },
  },

  rootCauseFound: {
    id: 'root-cause-found',
    description: 'Root cause must be identified',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const investigation = readObjectField(state, 'investigation');
      if (investigation != null && investigation.rootCause != null) return true;
      return {
        passed: false,
        reason: 'root-cause-found not satisfied',
        expectedShape: { investigation: { rootCause: '<description>' } },
      };
    },
  },

  hotfixTrackSelected: {
    id: 'hotfix-track-selected',
    description: 'Hotfix track must be selected',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      if (state.track === 'hotfix') return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: `hotfix-track-selected not satisfied: state.track must be 'hotfix' (current: ${JSON.stringify(state.track ?? undefined)})`,
        expectedShape: { track: 'hotfix' },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'update', featureId, updates: { track: 'hotfix' } },
        },
      };
    },
  },

  thoroughTrackSelected: {
    id: 'thorough-track-selected',
    description: 'Thorough track must be selected',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      if (state.track === 'thorough') return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: `thorough-track-selected not satisfied: state.track must be 'thorough' (current: ${JSON.stringify(state.track ?? undefined)})`,
        expectedShape: { track: 'thorough' },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'update', featureId, updates: { track: 'thorough' } },
        },
      };
    },
  },

  rcaDocumentComplete: makeArtifactGuard('rca', 'RCA document must be complete', 'rca-document-complete'),

  fixDesignComplete: makeArtifactGuard('fixDesign', 'Fix design must be complete', 'fix-design-complete'),

  implementationComplete: {
    id: 'implementation-complete',
    description: 'Implementation must be complete',
    evaluate: (): GuardResult => true,
  },

  validationPassed: {
    id: 'validation-passed',
    description: 'Validation must have passed',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const validation = readObjectField(state, 'validation');
      if (validation != null && validation.testsPass === true) return true;
      return {
        passed: false,
        reason: 'validation-passed not satisfied',
        expectedShape: { validation: { testsPass: true } },
      };
    },
  },

  reviewPassed: {
    id: 'review-passed',
    description: 'Review must have passed',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const reviews = readObjectField(state, 'reviews');
      if (!reviews) {
        return {
          passed: false,
          reason:
            'state.reviews is missing — set reviews.{name} with status: "pass" or "approved"',
          expectedShape: REVIEW_EXPECTED_SHAPE,
        };
      }
      const statuses = collectReviewStatuses(reviews);
      if (statuses.length === 0) {
        return {
          passed: false,
          reason:
            'state.reviews has no recognizable review entries — each review needs a status field',
          expectedShape: REVIEW_EXPECTED_SHAPE,
        };
      }
      const notPassed = statuses.filter((s) => !PASSED_STATUSES.has(s.status));
      if (notPassed.length > 0) {
        return {
          passed: false,
          reason: `Reviews not passed: ${notPassed.map((s) => `${s.path} (status: "${s.status}")`).join(', ')}`,
          expectedShape: buildFailedReviewsExpectedShape(notPassed),
        };
      }
      return true;
    },
  },

  /** Pass when `explore.scopeAssessment` or the legacy top-level `scopeAssessment` is set. */
  scopeAssessmentComplete: {
    id: 'scope-assessment-complete',
    description: 'Scope assessment must be complete',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const explore = readObjectField(state, 'explore');
      if (explore?.scopeAssessment != null) return true;
      if (state.scopeAssessment != null) return true;
      return {
        passed: false,
        reason: 'scope-assessment-complete not satisfied',
        expectedShape: { explore: { scopeAssessment: '<assessment>' } },
      };
    },
  },

  briefComplete: {
    id: 'brief-complete',
    description: 'Brief must be complete',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const brief = readObjectField(state, 'brief');
      if (brief != null && brief.goals != null) return true;
      return {
        passed: false,
        reason: 'brief-complete not satisfied',
        expectedShape: { brief: { goals: '<goals-array-or-description>' } },
      };
    },
  },

  polishTrackSelected: {
    id: 'polish-track-selected',
    description: 'Polish track must be selected',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      if (state.track === 'polish') return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: `polish-track-selected not satisfied: state.track must be 'polish' (current: ${JSON.stringify(state.track ?? undefined)})`,
        expectedShape: { track: 'polish' },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'update', featureId, updates: { track: 'polish' } },
        },
      };
    },
  },

  overhaulTrackSelected: {
    id: 'overhaul-track-selected',
    description: 'Overhaul track must be selected',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      if (state.track === 'overhaul') return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: `overhaul-track-selected not satisfied: state.track must be 'overhaul' (current: ${JSON.stringify(state.track ?? undefined)})`,
        expectedShape: { track: 'overhaul' },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'update', featureId, updates: { track: 'overhaul' } },
        },
      };
    },
  },

  docsUpdated: {
    id: 'docs-updated',
    description: 'Documentation must be updated',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const validation = readObjectField(state, 'validation');
      if (validation?.docsUpdated === true) return true;
      return {
        passed: false,
        reason: 'docs-updated not satisfied',
        expectedShape: { validation: { docsUpdated: true } },
      };
    },
  },

  goalsVerified: {
    id: 'goals-verified',
    description: 'Refactor goals must be verified',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const validation = readObjectField(state, 'validation');
      if (validation?.testsPass === true) return true;
      return {
        passed: false,
        reason: 'goals-verified not satisfied',
        expectedShape: { validation: { testsPass: true } },
      };
    },
  },

  planReviewComplete: {
    id: 'plan-review-complete',
    description: 'Plan review must be complete with no gaps',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const planReview = readObjectField(state, 'planReview');
      if (planReview?.approved === true) return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: 'plan-review-complete not satisfied: planReview.approved must be true',
        expectedShape: { planReview: { approved: true } },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'update', featureId, updates: { planReview: { approved: true } } },
        },
      };
    },
  },

  planReviewGapsFound: {
    id: 'plan-review-gaps-found',
    description: 'Plan review found coverage gaps',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const planReview = readObjectField(state, 'planReview');
      if (planReview?.gapsFound === true) return true;
      return {
        passed: false,
        reason: 'plan-review-gaps-found not satisfied: planReview.gapsFound must be true',
        expectedShape: { planReview: { gapsFound: true } },
      };
    },
  },

  mergeVerified: {
    id: 'merge-verified',
    description: 'Merge must be verified by the orchestrator before cleanup',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const cleanup = readObjectField(state, '_cleanup');
      if (!cleanup || cleanup.mergeVerified !== true) {
        return {
          passed: false,
          reason: 'Cleanup requires mergeVerified flag — verify PRs are merged via GitHub API before invoking cleanup',
        };
      }
      return true;
    },
  },

  /** Pass when no team was spawned, as in subagent mode, or when `team.disbanded` is in `_events`. */
  teamDisbandedEmitted: {
    id: 'team-disbanded-emitted',
    description: 'Team must be disbanded before transitioning out of delegation',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const events = readRecordArrayField(state, '_events');
      const hasTeamSpawned = events.some((e) => e.type === 'team.spawned');
      if (!hasTeamSpawned) return true;
      const hasDisbanded = events.some((e) => e.type === 'team.disbanded');
      if (hasDisbanded) return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: 'team-disbanded-emitted not satisfied: team.disbanded event not found in _events',
        expectedShape: {
          type: 'team.disbanded',
          data: {
            totalDurationMs: 'number',
            tasksCompleted: 'number',
            tasksFailed: 'number',
          },
        },
        suggestedFix: {
          tool: 'exarchos_event',
          params: {
            action: 'append',
            featureId,
            type: 'team.disbanded',
            data: {
              totalDurationMs: 0,
              tasksCompleted: 0,
              tasksFailed: 0,
            },
          },
        },
      };
    },
  },

  /**
   * Pass only when `artifacts.plan` is a typed artifact reference. `oneshot.planSummary`
   * is a label and not a plan, so it never satisfies the guard.
   */
  oneshotPlanSet: {
    id: 'oneshot-plan-set',
    description:
      'Oneshot workflow plan artifact is captured in state.artifacts.plan as a non-empty string (plan contents or path). `oneshot.planSummary` is a pipeline-view hint, not a plan, and is not sufficient alone to transition plan → implementing.',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const artifacts = readObjectField(state, 'artifacts');
      const plan = artifacts?.plan;
      if (isTypedArtifactReference(plan)) return true;
      const featureId = typeof state.featureId === 'string' ? state.featureId : '<featureId>';
      return {
        passed: false,
        reason:
          'oneshot-plan-set not satisfied: state.artifacts.plan is required (a non-empty string of plan contents or a plan path) before transitioning plan → implementing. `oneshot.planSummary` alone does not satisfy this guard, and non-string values (true, objects, numbers) are not accepted.',
        expectedShape: { artifacts: { plan: '<one-page plan contents or path>' } },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: {
            action: 'update',
            featureId,
            updates: { 'artifacts.plan': '<one-page plan contents or path>' },
          },
        },
      };
    },
  },

  synthesisOptedIn: {
    id: 'synthesis-opted-in',
    description:
      'Oneshot workflow opted into synthesis: synthesisPolicy=always OR a synthesize.requested event has been emitted on an on-request policy',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const policy = readSynthesisPolicy(state);
      if (policy === 'always') return true;
      if (policy === 'never') {
        return {
          passed: false,
          reason: 'synthesis-opted-in not satisfied: synthesisPolicy=never (direct-commit path)',
        };
      }
      if (hasSynthesizeRequestEvent(state)) return true;
      const featureId = typeof state.featureId === 'string' ? state.featureId : '<featureId>';
      return {
        passed: false,
        reason:
          'synthesis-opted-in not satisfied: synthesisPolicy=on-request but no synthesize.requested event in _events',
        expectedShape: {
          type: 'synthesize.requested',
          data: { featureId: '<featureId>', timestamp: '<ISO-8601>' },
        },
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: { action: 'request_synthesize', featureId },
        },
      };
    },
  },

  synthesisOptedOut: {
    id: 'synthesis-opted-out',
    description:
      'Oneshot workflow opted out of synthesis: synthesisPolicy=never OR an on-request policy with no synthesize.requested event (direct-commit path)',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const policy = readSynthesisPolicy(state);
      if (policy === 'never') return true;
      if (policy === 'always') {
        return {
          passed: false,
          reason: 'synthesis-opted-out not satisfied: synthesisPolicy=always (synthesize path)',
        };
      }
      if (!hasSynthesizeRequestEvent(state)) return true;
      return {
        passed: false,
        reason:
          'synthesis-opted-out not satisfied: synthesisPolicy=on-request with a synthesize.requested event present — opted into synthesis',
      };
    },
  },

  escalationRequired: {
    id: 'escalation-required',
    description: 'Investigation determined fix requires architectural redesign',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const investigation = readObjectField(state, 'investigation');
      if (investigation?.escalate === true) return true;
      return {
        passed: false,
        reason: 'escalation-required not satisfied',
        expectedShape: { investigation: { escalate: true } },
      };
    },
  },

  /**
   * Pass when `planReview.revisionCount` reaches the cap. The cap is the injected
   * `_maxPlanRevisions` config value, or the default. It is not event-sourced state.
   */
  revisionsExhausted: {
    id: 'revisions-exhausted',
    description: 'Plan revision count has reached the maximum allowed',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const planReview = readObjectField(state, 'planReview');
      const rawCount = planReview?.revisionCount;
      const count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : 0;
      const rawCap = state._maxPlanRevisions;
      const cap = typeof rawCap === 'number' && Number.isFinite(rawCap) ? rawCap : DEFAULT_MAX_PLAN_REVISIONS;
      if (count >= cap) return true;
      return {
        passed: false,
        reason: `revisions-exhausted not satisfied: ${count}/${cap} revisions`,
      };
    },
  },

  prRequested: {
    id: 'pr-requested',
    description: 'PR creation has been requested',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const synthesis = readObjectField(state, 'synthesis');
      if (synthesis?.requested === true) return true;
      return {
        passed: false,
        reason: 'pr-requested not satisfied',
        expectedShape: { synthesis: { requested: true } },
      };
    },
  },

  synthesizeRetryable: {
    id: 'synthesize-retryable',
    description: 'Synthesis can be retried (has error and retries remaining)',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const synthesis = readObjectField(state, 'synthesis');
      if (synthesis?.lastError == null) {
        return {
          passed: false,
          reason: 'synthesize-retryable not satisfied: no lastError recorded',
        };
      }
      const rawRetry = synthesis.retryCount;
      const retryCount = typeof rawRetry === 'number' && Number.isFinite(rawRetry) ? rawRetry : 0;
      if (retryCount >= MAX_SYNTHESIZE_RETRIES) {
        return {
          passed: false,
          reason: `synthesize-retryable not satisfied: ${retryCount}/${MAX_SYNTHESIZE_RETRIES} retries exhausted`,
        };
      }
      return true;
    },
  },

  fixVerifiedDirectly: {
    id: 'fix-verified-directly',
    description: 'Fix was pushed directly to main without PR',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const resolution = readObjectField(state, 'resolution');
      if (resolution?.directPush === true && resolution.commitSha != null) return true;
      return {
        passed: false,
        reason: 'fix-verified-directly not satisfied: resolution.directPush and resolution.commitSha required',
        expectedShape: { resolution: { directPush: true, commitSha: '<commit-sha>' } },
      };
    },
  },

  sourcesCollected: {
    id: 'sources-collected',
    description: 'Research sources must be collected',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const artifacts = readObjectField(state, 'artifacts');
      const sources = artifacts?.sources;
      if (Array.isArray(sources) && sources.length > 0) return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: 'sources-collected not satisfied: artifacts.sources must be a non-empty array',
        expectedShape: { artifacts: { sources: ['<source-path-or-url>'] } },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'update', featureId, updates: { 'artifacts.sources': ['<source>'] } },
        },
      };
    },
  },

  reportArtifactExists: makeArtifactGuard('report', 'Report artifact must exist'),

  always: {
    id: 'always',
    description: 'Always passes',
    evaluate: (): GuardResult => true,
  },
} as const satisfies Record<string, Guard>;
