import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const IDEATE_READINESS_VIEW = 'ideate-readiness';

// ─── View State Interface ─────────────────────────────────────────────────

export interface IdeateReadinessState {
  readonly ready: boolean;
  readonly designArtifactExists: boolean;
  readonly gateResult: {
    readonly checked: boolean;
    readonly passed: boolean;
    readonly advisory: boolean;
    readonly findings: readonly string[];
  };
}

// ─── Readiness Predicate ────────────────────────────────────────────────────

function isReady(state: IdeateReadinessState): boolean {
  return state.designArtifactExists && state.gateResult.checked && state.gateResult.passed;
}

// ─── Gate Name Matching ─────────────────────────────────────────────────────

function isDesignCompletenessGate(gateName: string): boolean {
  return gateName.includes('design-completeness');
}

// ─── Event Handlers ────────────────────────────────────────────────────────

function handleWorkflowTransition(
  state: IdeateReadinessState,
  event: WorkflowEvent,
): IdeateReadinessState {
  const data = event.data as { to?: string } | undefined;
  if (!data?.to) return state;

  if (data.to === 'plan') {
    const updated: IdeateReadinessState = {
      ...state,
      designArtifactExists: true,
    };
    return { ...updated, ready: isReady(updated) };
  }

  return state;
}

function handleGateExecuted(
  state: IdeateReadinessState,
  event: WorkflowEvent,
): IdeateReadinessState {
  const data = event.data as {
    gateName?: string;
    passed?: boolean;
    details?: Record<string, unknown>;
  } | undefined;

  if (!data?.gateName) return state;
  if (!isDesignCompletenessGate(data.gateName)) return state;

  const passed = data.passed ?? false;
  const details = data.details ?? {};
  const advisory = details.advisory === true;
  const findings = Array.isArray(details.findings)
    ? (details.findings as string[])
    : [];

  const updated: IdeateReadinessState = {
    ...state,
    gateResult: {
      checked: true,
      passed,
      advisory,
      findings,
    },
  };

  return { ...updated, ready: isReady(updated) };
}

// ─── Projection ────────────────────────────────────────────────────────────

export const ideateReadinessProjection: ViewProjection<IdeateReadinessState> = {
  init: (): IdeateReadinessState => ({
    ready: false,
    designArtifactExists: false,
    gateResult: {
      checked: false,
      passed: false,
      advisory: false,
      findings: [],
    },
  }),

  apply: (view: IdeateReadinessState, event: WorkflowEvent): IdeateReadinessState => {
    switch (event.type) {
      case 'workflow.transition':
        return handleWorkflowTransition(view, event);

      case 'gate.executed':
        return handleGateExecuted(view, event);

      default:
        return view;
    }
  },
};
