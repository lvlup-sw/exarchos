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
  reviews: { '<name>': { status: 'pass' } },
};

/**
 * Collects all `status` field values from a reviews object, handling both flat
 * and nested shapes:
 *   - flat:   reviews.overhaul = { status: "approved", ... }
 *   - nested: reviews.A1 = { specReview: { status: "pass" }, qualityReview: { status: "approved" } }
 * Also supports the legacy `passed: boolean` shape for backward compatibility.
 */
export function collectReviewStatuses(
  reviews: Record<string, unknown>,
): Array<{ path: string; status: string }> {
  const results: Array<{ path: string; status: string }> = [];
  for (const [key, value] of Object.entries(reviews)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.status === 'string') {
      // Flat review: { status: "approved", ... }
      results.push({ path: key, status: entry.status });
    } else if (typeof entry.passed === 'boolean') {
      // Legacy: { passed: true/false }
      results.push({ path: key, status: entry.passed ? 'passed' : 'failed' });
    } else {
      // Nested: { specReview: { status: "pass" }, qualityReview: { status: "approved" } }
      for (const [subKey, subValue] of Object.entries(entry)) {
        if (typeof subValue !== 'object' || subValue === null) continue;
        const sub = subValue as Record<string, unknown>;
        if (typeof sub.status === 'string') {
          results.push({ path: `${key}.${subKey}`, status: sub.status });
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
    description: 'All reviews must have passed',
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
            'state.reviews has no recognizable review entries — each review needs a status field ("pass", "approved", "fail", "needs_fixes")',
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
      return { passed: false, reason: 'pr-url-exists not satisfied' };
    },
  },

  humanUnblocked: {
    id: 'human-unblocked',
    description: 'Human must have unblocked the workflow',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      if (state.unblocked === true) return true;
      return { passed: false, reason: 'human-unblocked not satisfied' };
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
      return { passed: false, reason: 'hotfix-track-selected not satisfied' };
    },
  },

  thoroughTrackSelected: {
    id: 'thorough-track-selected',
    description: 'Thorough track must be selected',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      if (state.track === 'thorough') return true;
      return { passed: false, reason: 'thorough-track-selected not satisfied' };
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
      const explore = state.explore as Record<string, unknown> | undefined;
      if (explore?.scopeAssessment != null) return true;
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
      return { passed: false, reason: 'polish-track-selected not satisfied' };
    },
  },

  overhaulTrackSelected: {
    id: 'overhaul-track-selected',
    description: 'Overhaul track must be selected',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      if (state.track === 'overhaul') return true;
      return { passed: false, reason: 'overhaul-track-selected not satisfied' };
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
      return { passed: false, reason: 'plan-review-complete not satisfied' };
    },
  },

  planReviewGapsFound: {
    id: 'plan-review-gaps-found',
    description: 'Plan review found coverage gaps',
    evaluate: (state: Record<string, unknown>): GuardResult => {
      const planReview = state.planReview as Record<string, unknown> | undefined;
      if (planReview?.gapsFound === true) return true;
      return { passed: false, reason: 'plan-review-gaps-found not satisfied' };
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
      if (!synthesis?.lastError) {
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

  always: {
    id: 'always',
    description: 'Always passes',
    evaluate: () => true as GuardResult,
  },
} as const satisfies Record<string, Guard>;
