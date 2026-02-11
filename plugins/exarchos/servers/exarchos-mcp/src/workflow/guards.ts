// ─── Guard Types ────────────────────────────────────────────────────────────

export type GuardResult = boolean | { readonly passed: false; readonly reason: string };

export interface Guard {
  readonly id: string;
  readonly evaluate: (state: Record<string, unknown>) => GuardResult;
  readonly description: string;
}

// ─── Guard Helpers ──────────────────────────────────────────────────────────

function hasArtifact(field: string): Guard {
  return {
    id: `${field}-exists`,
    description: `${field} artifact must exist`,
    evaluate: (state: Record<string, unknown>) => {
      const artifacts = state.artifacts as Record<string, unknown> | undefined;
      return artifacts != null && artifacts[field] != null;
    },
  };
}

export const PASSED_STATUSES = new Set(['pass', 'passed', 'approved']);
export const FAILED_STATUSES = new Set(['fail', 'failed', 'needs_fixes']);

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

// ─── Guards ─────────────────────────────────────────────────────────────────

export const guards = {
  designArtifactExists: {
    id: 'design-artifact-exists',
    description: 'Design artifact must exist',
    evaluate: (state: Record<string, unknown>) => {
      const artifacts = state.artifacts as Record<string, unknown> | undefined;
      return artifacts != null && artifacts.design != null;
    },
  },

  planArtifactExists: {
    id: 'plan-artifact-exists',
    description: 'Plan artifact must exist',
    evaluate: (state: Record<string, unknown>) => {
      const artifacts = state.artifacts as Record<string, unknown> | undefined;
      return artifacts != null && artifacts.plan != null;
    },
  },

  allTasksComplete: {
    id: 'all-tasks-complete',
    description: 'All tasks must be complete',
    evaluate: (state: Record<string, unknown>) => {
      const tasks = state.tasks as Array<{ status: string }> | undefined;
      if (!tasks || tasks.length === 0) return true;
      return tasks.every((t) => t.status === 'complete');
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
        };
      }
      const statuses = collectReviewStatuses(reviews);
      if (statuses.length === 0) {
        return {
          passed: false,
          reason:
            'state.reviews has no recognizable review entries — each review needs a status field ("pass", "approved", "fail", "needs_fixes")',
        };
      }
      const notPassed = statuses.filter((s) => !PASSED_STATUSES.has(s.status));
      if (notPassed.length > 0) {
        return {
          passed: false,
          reason: `Reviews not passed: ${notPassed.map((s) => `${s.path} (status: "${s.status}")`).join(', ')}`,
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
        };
      }
      const statuses = collectReviewStatuses(reviews);
      if (statuses.length === 0) {
        return { passed: false, reason: 'state.reviews has no recognizable review entries' };
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
    evaluate: (state: Record<string, unknown>) => {
      const synthesis = state.synthesis as Record<string, unknown> | undefined;
      if (synthesis?.prUrl != null) return true;
      const artifacts = state.artifacts as Record<string, unknown> | undefined;
      return artifacts?.pr != null;
    },
  },

  humanUnblocked: {
    id: 'human-unblocked',
    description: 'Human must have unblocked the workflow',
    evaluate: (state: Record<string, unknown>) => {
      return state.unblocked === true;
    },
  },

  triageComplete: {
    id: 'triage-complete',
    description: 'Triage must be complete',
    evaluate: (state: Record<string, unknown>) => {
      const triage = state.triage as Record<string, unknown> | undefined;
      return triage != null && triage.symptom != null;
    },
  },

  rootCauseFound: {
    id: 'root-cause-found',
    description: 'Root cause must be identified',
    evaluate: (state: Record<string, unknown>) => {
      const investigation = state.investigation as Record<string, unknown> | undefined;
      return investigation != null && investigation.rootCause != null;
    },
  },

  hotfixTrackSelected: {
    id: 'hotfix-track-selected',
    description: 'Hotfix track must be selected',
    evaluate: (state: Record<string, unknown>) => {
      return state.track === 'hotfix';
    },
  },

  thoroughTrackSelected: {
    id: 'thorough-track-selected',
    description: 'Thorough track must be selected',
    evaluate: (state: Record<string, unknown>) => {
      return state.track === 'thorough';
    },
  },

  rcaDocumentComplete: {
    id: 'rca-document-complete',
    description: 'RCA document must be complete',
    evaluate: (state: Record<string, unknown>) => {
      const artifacts = state.artifacts as Record<string, unknown> | undefined;
      return artifacts?.rca != null;
    },
  },

  fixDesignComplete: {
    id: 'fix-design-complete',
    description: 'Fix design must be complete',
    evaluate: (state: Record<string, unknown>) => {
      const artifacts = state.artifacts as Record<string, unknown> | undefined;
      return artifacts?.fixDesign != null;
    },
  },

  implementationComplete: {
    id: 'implementation-complete',
    description: 'Implementation must be complete',
    evaluate: () => true,
  },

  validationPassed: {
    id: 'validation-passed',
    description: 'Validation must have passed',
    evaluate: (state: Record<string, unknown>) => {
      const validation = state.validation as Record<string, unknown> | undefined;
      return validation != null && validation.testsPass === true;
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
        };
      }
      const statuses = collectReviewStatuses(reviews);
      if (statuses.length === 0) {
        return {
          passed: false,
          reason:
            'state.reviews has no recognizable review entries — each review needs a status field',
        };
      }
      const notPassed = statuses.filter((s) => !PASSED_STATUSES.has(s.status));
      if (notPassed.length > 0) {
        return {
          passed: false,
          reason: `Reviews not passed: ${notPassed.map((s) => `${s.path} (status: "${s.status}")`).join(', ')}`,
        };
      }
      return true;
    },
  },

  scopeAssessmentComplete: {
    id: 'scope-assessment-complete',
    description: 'Scope assessment must be complete',
    evaluate: (state: Record<string, unknown>) => {
      const explore = state.explore as Record<string, unknown> | undefined;
      return explore?.scopeAssessment != null;
    },
  },

  briefComplete: {
    id: 'brief-complete',
    description: 'Brief must be complete',
    evaluate: (state: Record<string, unknown>) => {
      const brief = state.brief as Record<string, unknown> | undefined;
      return brief != null && brief.goals != null;
    },
  },

  polishTrackSelected: {
    id: 'polish-track-selected',
    description: 'Polish track must be selected',
    evaluate: (state: Record<string, unknown>) => {
      return state.track === 'polish';
    },
  },

  overhaulTrackSelected: {
    id: 'overhaul-track-selected',
    description: 'Overhaul track must be selected',
    evaluate: (state: Record<string, unknown>) => {
      return state.track === 'overhaul';
    },
  },

  docsUpdated: {
    id: 'docs-updated',
    description: 'Documentation must be updated',
    evaluate: (state: Record<string, unknown>) => {
      const validation = state.validation as Record<string, unknown> | undefined;
      return validation?.docsUpdated === true;
    },
  },

  goalsVerified: {
    id: 'goals-verified',
    description: 'Refactor goals must be verified',
    evaluate: (state: Record<string, unknown>) => {
      const validation = state.validation as Record<string, unknown> | undefined;
      return validation?.testsPass === true;
    },
  },

  planReviewComplete: {
    id: 'plan-review-complete',
    description: 'Plan review must be complete with no gaps',
    evaluate: (state: Record<string, unknown>) => {
      const planReview = state.planReview as Record<string, unknown> | undefined;
      return planReview?.approved === true;
    },
  },

  planReviewGapsFound: {
    id: 'plan-review-gaps-found',
    description: 'Plan review found coverage gaps',
    evaluate: (state: Record<string, unknown>) => {
      const planReview = state.planReview as Record<string, unknown> | undefined;
      return planReview?.gapsFound === true;
    },
  },

  always: {
    id: 'always',
    description: 'Always passes',
    evaluate: () => true,
  },
} as const satisfies Record<string, Guard>;
