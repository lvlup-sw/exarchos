// ─── Guard Types ────────────────────────────────────────────────────────────

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

// ─── Guard Composition ──────────────────────────────────────────────────────

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

// ─── Guard Helpers ──────────────────────────────────────────────────────────

function makeArtifactGuard(field: string, description: string, customId?: string): Guard {
  const id = customId ?? `${field}-artifact-exists`;
  return {
    id,
    description,
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const artifacts = state.artifacts as Record<string, unknown> | undefined;
      if (artifacts != null && artifacts[field] != null) return true;
      // Fallback: check top-level field
      if (state[field] != null) return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: `${id} not satisfied`,
        expectedShape: { artifacts: { [field]: '<path-or-content>' } },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: {
            action: 'set',
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
 * Extract the review status string from an entry, checking `status` first,
 * then `verdict` as a synonym (see GitHub #1004). Values are normalized to
 * lowercase so that uppercase verdicts like `"PASS"` / `"APPROVED"` —
 * commonly produced by agents copying `check_review_verdict`'s uppercase
 * discriminated-union return values into state — match the lowercase
 * PASSED_STATUSES / FAILED_STATUSES sets (see GitHub #1075).
 */
function extractStatus(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.status === 'string') return entry.status.toLowerCase();
  if (typeof entry.verdict === 'string') return entry.verdict.toLowerCase();
  return undefined;
}

/**
 * Collects all review status values from a reviews object, handling both flat
 * and nested shapes:
 *   - flat:   reviews.overhaul = { status: "approved", ... }
 *   - flat:   reviews.overhaul = { verdict: "pass", ... }
 *   - nested: reviews.A1 = { specReview: { status: "pass" }, qualityReview: { verdict: "approved" } }
 * Also supports the legacy `passed: boolean` shape for backward compatibility.
 */
export function collectReviewStatuses(
  reviews: Record<string, unknown>,
): Array<{ path: string; status: string }> {
  const results: Array<{ path: string; status: string }> = [];
  for (const [key, value] of Object.entries(reviews)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    const status = extractStatus(entry);
    if (status !== undefined) {
      // Flat review: { status: "approved", ... } or { verdict: "pass", ... }
      results.push({ path: key, status });
    } else if (typeof entry.passed === 'boolean') {
      // Legacy: { passed: true/false }
      results.push({ path: key, status: entry.passed ? 'passed' : 'failed' });
    } else {
      // Nested: { specReview: { status: "pass" }, qualityReview: { verdict: "approved" } }
      for (const [subKey, subValue] of Object.entries(entry)) {
        if (typeof subValue !== 'object' || subValue === null) continue;
        const sub = subValue as Record<string, unknown>;
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
 * Builds an expectedShape for failed reviews, listing each failed path with { status: 'pass' }.
 * Handles dotted paths (e.g. "A1.specReview") by building nested objects.
 */
function buildFailedReviewsExpectedShape(
  notPassed: Array<{ path: string; status: string }>,
): Record<string, unknown> {
  const reviewEntries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const s of notPassed) {
    const parts = s.path.split('.');
    let cursor: Record<string, unknown> = reviewEntries;
    let skip = false;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (UNSAFE_KEYS.has(key)) { skip = true; break; }
      if (typeof cursor[key] !== 'object' || cursor[key] === null) {
        cursor[key] = Object.create(null) as Record<string, unknown>;
      }
      cursor = cursor[key] as Record<string, unknown>;
    }
    if (skip) continue;
    const leafKey = parts[parts.length - 1];
    if (!UNSAFE_KEYS.has(leafKey)) {
      cursor[leafKey] = { status: 'pass' };
    }
  }
  return { reviews: reviewEntries };
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_PLAN_REVISIONS = 3;
const MAX_SYNTHESIZE_RETRIES = 3;

// ─── Guards ─────────────────────────────────────────────────────────────────

export const guards = {
  designArtifactExists: makeArtifactGuard('design', 'Design artifact must exist'),

  planArtifactExists: makeArtifactGuard('plan', 'Plan artifact must exist'),

  allTasksComplete: {
    id: 'all-tasks-complete',
    description: 'All tasks must be complete',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const tasks = state.tasks as Array<{ id?: string; status: string }> | undefined;
      if (!tasks || tasks.length === 0) return true;
      if (tasks.every((t) => t.status === 'complete')) return true;
      const incomplete = tasks.filter((t) => t.status !== 'complete');
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: `all-tasks-complete not satisfied: ${incomplete.length} task(s) incomplete`,
        expectedShape: { tasks: [{ id: '<task-id>', status: 'complete' }] },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: {
            action: 'set',
            featureId,
            updates: {
              tasks: incomplete.map((t) => ({
                id: t.id ?? '<task-id>',
                status: 'complete',
              })),
            },
          },
        },
      };
    },
  },

  allReviewsPassed: {
    id: 'all-reviews-passed',
    description: 'All required reviews must be present and have passed',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const reviews = state.reviews as Record<string, unknown> | undefined;
      if (!reviews) {
        return {
          passed: false,
          reason:
            'state.reviews is missing — set reviews.{name} with status: "pass" or "approved"',
          expectedShape: REVIEW_EXPECTED_SHAPE,
        };
      }

      // Accumulate ALL failures rather than short-circuiting on the first
      // one (see GitHub #1074). An agent hitting multiple contract violations
      // should see everything wrong in one error message so it can fix
      // everything in a single retry.
      const featureId = typeof state.featureId === 'string' ? state.featureId : '<featureId>';
      const reasons: string[] = [];
      const expectedReviews: Record<string, unknown> = {};
      const suggestedUpdates: Record<string, unknown> = {};

      // Check 1: required review dimensions present AND have a
      // recognizable status? `!reviews[key]` is not enough — it accepts
      // `{}` (truthy but no status field) and prototype-inherited keys
      // like `__proto__`. A present-but-empty entry would then be
      // skipped by `collectReviewStatuses` and the guard would return
      // true with nothing actually verified. CodeRabbit finding on #1076.
      const requiredReviews = state._requiredReviews as readonly string[] | undefined;
      const missing: string[] = [];
      if (requiredReviews && requiredReviews.length > 0) {
        for (const key of requiredReviews) {
          if (UNSAFE_KEYS.has(key)) {
            // Never trust proto-pollution keys as "present" — they're
            // inherited on every object.
            missing.push(key);
            continue;
          }
          if (!Object.prototype.hasOwnProperty.call(reviews, key)) {
            missing.push(key);
            continue;
          }
          const entry = reviews[key];
          if (typeof entry !== 'object' || entry === null) {
            missing.push(key);
            continue;
          }
          const entryObj = entry as Record<string, unknown>;
          // Must carry at least one recognizable shape: status, verdict,
          // or legacy `passed: boolean`. An empty `{}` is not present.
          const hasStatus = extractStatus(entryObj) !== undefined;
          const hasLegacyPassed = typeof entryObj.passed === 'boolean';
          if (!hasStatus && !hasLegacyPassed) {
            missing.push(key);
          }
        }
        if (missing.length > 0) {
          reasons.push(
            `Missing required review dimensions: ${missing.join(', ')}. Run the review skills for these dimensions before transitioning.`,
          );
          // Populate expectedShape and suggestedFix payloads, but filter
          // UNSAFE_KEYS out — an agent blindly applying the suggestedFix
          // must not be tricked into writing `reviews.__proto__.status`
          // (prototype pollution). The reason string still names the
          // unsafe key so the caller understands what was rejected.
          for (const key of missing) {
            if (UNSAFE_KEYS.has(key)) continue;
            expectedReviews[key] = { status: 'pass' };
            suggestedUpdates[`reviews.${key}.status`] = 'pass';
          }
        }
      }

      // Check 2: at least one recognizable review entry exists.
      const statuses = collectReviewStatuses(reviews);
      if (statuses.length === 0) {
        // If no entries AND required dimensions were missing, the "missing
        // dimensions" message is more actionable. Only surface the
        // no-entries message when it adds information.
        if (missing.length === 0) {
          return {
            passed: false,
            reason:
              'state.reviews has no recognizable review entries — each review needs a status field ("pass", "approved", "fail", "needs_fixes")',
            expectedShape: REVIEW_EXPECTED_SHAPE,
          };
        }
      }

      // Check 3: every present review entry passes.
      const notPassed = statuses.filter((s) => !PASSED_STATUSES.has(s.status));
      if (notPassed.length > 0) {
        reasons.push(
          `Reviews not passed: ${notPassed.map((s) => `${s.path} (status: "${s.status}")`).join(', ')}`,
        );
        const failedShape = buildFailedReviewsExpectedShape(notPassed).reviews as
          | Record<string, unknown>
          | undefined;
        if (failedShape) {
          for (const [k, v] of Object.entries(failedShape)) {
            expectedReviews[k] = v;
          }
        }
        // Include failing entries in the suggestedFix dot-path patch so
        // an agent applying the fix can resolve BOTH missing dimensions
        // AND present-but-failing entries in a single retry (CodeRabbit
        // finding on PR #1076). `s.path` may be dotted for nested
        // reviews (e.g., "A1.specReview"), which dot-path assignment
        // handles correctly downstream. Skip any path whose segments
        // contain an UNSAFE_KEY for the same prototype-pollution reason
        // as the missing-dimensions loop above.
        for (const s of notPassed) {
          const segments = s.path.split('.');
          if (segments.some((seg) => UNSAFE_KEYS.has(seg))) continue;
          suggestedUpdates[`reviews.${s.path}.status`] = 'pass';
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
                params: { action: 'set', featureId, updates: suggestedUpdates },
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
      const reviews = state.reviews as Record<string, unknown> | undefined;
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
      const synthesis = state.synthesis as Record<string, unknown> | undefined;
      if (synthesis?.prUrl != null) return true;
      const artifacts = state.artifacts as Record<string, unknown> | undefined;
      if (artifacts?.pr != null) return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: 'pr-url-exists not satisfied: synthesis.prUrl or artifacts.pr must be set',
        expectedShape: { synthesis: { prUrl: '<pr-url>' } },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'set', featureId, updates: { synthesis: { prUrl: '<pr-url>' } } },
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
          params: { action: 'set', featureId, updates: { unblocked: true } },
        },
      };
    },
  },

  triageComplete: {
    id: 'triage-complete',
    description: 'Triage must be complete',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const triage = state.triage as Record<string, unknown> | undefined;
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
      const investigation = state.investigation as Record<string, unknown> | undefined;
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
          params: { action: 'set', featureId, updates: { track: 'hotfix' } },
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
          params: { action: 'set', featureId, updates: { track: 'thorough' } },
        },
      };
    },
  },

  rcaDocumentComplete: makeArtifactGuard('rca', 'RCA document must be complete', 'rca-document-complete'),

  fixDesignComplete: makeArtifactGuard('fixDesign', 'Fix design must be complete', 'fix-design-complete'),

  implementationComplete: {
    id: 'implementation-complete',
    description: 'Implementation must be complete',
    evaluate: () => true as GuardResult,
  },

  validationPassed: {
    id: 'validation-passed',
    description: 'Validation must have passed',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const validation = state.validation as Record<string, unknown> | undefined;
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
      const reviews = state.reviews as Record<string, unknown> | undefined;
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

  scopeAssessmentComplete: {
    id: 'scope-assessment-complete',
    description: 'Scope assessment must be complete',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      // Check under explore.scopeAssessment (canonical) or root scopeAssessment (legacy/convenience)
      const explore = state.explore as Record<string, unknown> | undefined;
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
      const brief = state.brief as Record<string, unknown> | undefined;
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
          params: { action: 'set', featureId, updates: { track: 'polish' } },
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
          params: { action: 'set', featureId, updates: { track: 'overhaul' } },
        },
      };
    },
  },

  docsUpdated: {
    id: 'docs-updated',
    description: 'Documentation must be updated',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const validation = state.validation as Record<string, unknown> | undefined;
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
      const validation = state.validation as Record<string, unknown> | undefined;
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
      const planReview = state.planReview as Record<string, unknown> | undefined;
      if (planReview?.approved === true) return true;
      const featureId = (typeof state.featureId === 'string' ? state.featureId : '<featureId>');
      return {
        passed: false,
        reason: 'plan-review-complete not satisfied: planReview.approved must be true',
        expectedShape: { planReview: { approved: true } },
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'set', featureId, updates: { planReview: { approved: true } } },
        },
      };
    },
  },

  planReviewGapsFound: {
    id: 'plan-review-gaps-found',
    description: 'Plan review found coverage gaps',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const planReview = state.planReview as Record<string, unknown> | undefined;
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
      const cleanup = state._cleanup as Record<string, unknown> | undefined;
      if (!cleanup || cleanup.mergeVerified !== true) {
        return {
          passed: false,
          reason: 'Cleanup requires mergeVerified flag — verify PRs are merged via GitHub API before invoking cleanup',
        };
      }
      return true;
    },
  },

  teamDisbandedEmitted: {
    id: 'team-disbanded-emitted',
    description: 'Team must be disbanded before transitioning out of delegation',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const events = (state._events as readonly Record<string, unknown>[]) ?? [];
      // No team spawned (subagent mode) — guard passes automatically
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

  escalationRequired: {
    id: 'escalation-required',
    description: 'Investigation determined fix requires architectural redesign',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const investigation = state.investigation as Record<string, unknown> | undefined;
      if (investigation?.escalate === true) return true;
      return {
        passed: false,
        reason: 'escalation-required not satisfied',
        expectedShape: { investigation: { escalate: true } },
      };
    },
  },

  revisionsExhausted: {
    id: 'revisions-exhausted',
    description: 'Plan revision count has reached the maximum allowed',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const planReview = state.planReview as Record<string, unknown> | undefined;
      const rawCount = planReview?.revisionCount;
      const count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : 0;
      if (count >= MAX_PLAN_REVISIONS) return true;
      return {
        passed: false,
        reason: `revisions-exhausted not satisfied: ${count}/${MAX_PLAN_REVISIONS} revisions`,
      };
    },
  },

  prRequested: {
    id: 'pr-requested',
    description: 'PR creation has been requested',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const synthesis = state.synthesis as Record<string, unknown> | undefined;
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
      const synthesis = state.synthesis as Record<string, unknown> | undefined;
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
      const resolution = state.resolution as Record<string, unknown> | undefined;
      if (resolution?.directPush === true && resolution.commitSha != null) return true;
      return {
        passed: false,
        reason: 'fix-verified-directly not satisfied: resolution.directPush and resolution.commitSha required',
        expectedShape: { resolution: { directPush: true, commitSha: '<commit-sha>' } },
      };
    },
  },

  always: {
    id: 'always',
    description: 'Always passes',
    evaluate: () => true as GuardResult,
  },
} as const satisfies Record<string, Guard>;
