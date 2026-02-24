import { guards, composeGuards } from './guards.js';
import type { HSMDefinition, State, Transition } from './state-machine.js';

// ─── Feature Workflow HSM ───────────────────────────────────────────────────

export function createFeatureHSM(): HSMDefinition {
  const states: Record<string, State> = {
    ideate: { id: 'ideate', type: 'atomic' },
    plan: { id: 'plan', type: 'atomic' },
    'plan-review': { id: 'plan-review', type: 'atomic' },
    implementation: {
      id: 'implementation',
      type: 'compound',
      initial: 'delegate',
      maxFixCycles: 3,
      onEntry: ['log'],
      onExit: ['log'],
    },
    delegate: { id: 'delegate', type: 'atomic', parent: 'implementation' },
    review: { id: 'review', type: 'atomic', parent: 'implementation' },
    synthesize: { id: 'synthesize', type: 'atomic' },
    completed: { id: 'completed', type: 'final' },
    cancelled: { id: 'cancelled', type: 'final' },
    blocked: { id: 'blocked', type: 'atomic' },
  };

  const transitions: Transition[] = [
    { from: 'ideate', to: 'plan', guard: guards.designArtifactExists },
    { from: 'plan', to: 'plan-review', guard: guards.planArtifactExists },
    { from: 'plan-review', to: 'delegate', guard: guards.planReviewComplete },
    {
      from: 'plan-review',
      to: 'plan',
      guard: guards.planReviewGapsFound,
      effects: ['log'],
    },
    { from: 'plan-review', to: 'blocked', guard: guards.revisionsExhausted },
    { from: 'delegate', to: 'review', guard: composeGuards(
      'all-tasks-complete+team-disbanded',
      'All tasks must be complete and team must be disbanded',
      guards.allTasksComplete,
      guards.teamDisbandedEmitted,
    ) },
    { from: 'review', to: 'synthesize', guard: guards.allReviewsPassed },
    {
      from: 'review',
      to: 'delegate',
      guard: guards.anyReviewFailed,
      isFixCycle: true,
      effects: ['increment-fix-cycle'],
    },
    { from: 'synthesize', to: 'completed', guard: guards.prUrlExists },
    { from: 'blocked', to: 'delegate', guard: guards.humanUnblocked },
  ];

  return { id: 'feature', states, transitions };
}

// ─── Debug Workflow HSM ─────────────────────────────────────────────────────

export function createDebugHSM(): HSMDefinition {
  const states: Record<string, State> = {
    triage: { id: 'triage', type: 'atomic' },
    investigate: { id: 'investigate', type: 'atomic' },

    // Thorough track compound
    'thorough-track': {
      id: 'thorough-track',
      type: 'compound',
      initial: 'rca',
      maxFixCycles: 2,
      onEntry: ['log'],
      onExit: ['log'],
    },
    rca: { id: 'rca', type: 'atomic', parent: 'thorough-track' },
    design: { id: 'design', type: 'atomic', parent: 'thorough-track' },
    'debug-implement': {
      id: 'debug-implement',
      type: 'atomic',
      parent: 'thorough-track',
    },
    'debug-validate': {
      id: 'debug-validate',
      type: 'atomic',
      parent: 'thorough-track',
    },
    'debug-review': {
      id: 'debug-review',
      type: 'atomic',
      parent: 'thorough-track',
    },

    // Hotfix track compound
    'hotfix-track': {
      id: 'hotfix-track',
      type: 'compound',
      initial: 'hotfix-implement',
      onEntry: ['log'],
      onExit: ['log'],
    },
    'hotfix-implement': {
      id: 'hotfix-implement',
      type: 'atomic',
      parent: 'hotfix-track',
    },
    'hotfix-validate': {
      id: 'hotfix-validate',
      type: 'atomic',
      parent: 'hotfix-track',
    },

    synthesize: { id: 'synthesize', type: 'atomic' },
    completed: { id: 'completed', type: 'final' },
    cancelled: { id: 'cancelled', type: 'final' },
    blocked: { id: 'blocked', type: 'atomic' },
  };

  const transitions: Transition[] = [
    { from: 'triage', to: 'investigate', guard: guards.triageComplete },

    // Investigate -> thorough or hotfix
    { from: 'investigate', to: 'rca', guard: guards.thoroughTrackSelected },
    {
      from: 'investigate',
      to: 'hotfix-implement',
      guard: guards.hotfixTrackSelected,
    },
    { from: 'investigate', to: 'cancelled', guard: guards.escalationRequired },

    // Thorough track flow
    { from: 'rca', to: 'design', guard: guards.rcaDocumentComplete },
    { from: 'design', to: 'debug-implement', guard: guards.fixDesignComplete },
    {
      from: 'debug-implement',
      to: 'debug-validate',
      guard: guards.implementationComplete,
    },
    { from: 'debug-validate', to: 'debug-review', guard: guards.validationPassed },
    { from: 'debug-review', to: 'synthesize', guard: guards.reviewPassed },

    // Hotfix track flow
    {
      from: 'hotfix-implement',
      to: 'hotfix-validate',
      guard: guards.implementationComplete,
    },
    { from: 'hotfix-validate', to: 'synthesize', guard: composeGuards(
      'validation+pr-requested',
      'Validation must pass and PR must be requested',
      guards.validationPassed,
      guards.prRequested,
    ) },
    { from: 'hotfix-validate', to: 'completed', guard: guards.validationPassed },

    // Synthesize -> completed
    { from: 'synthesize', to: 'completed', guard: guards.prUrlExists },
  ];

  return { id: 'debug', states, transitions };
}

// ─── Refactor Workflow HSM ──────────────────────────────────────────────────

export function createRefactorHSM(): HSMDefinition {
  const states: Record<string, State> = {
    explore: { id: 'explore', type: 'atomic' },
    brief: { id: 'brief', type: 'atomic' },

    // Polish track compound
    'polish-track': {
      id: 'polish-track',
      type: 'compound',
      initial: 'polish-implement',
      onEntry: ['log'],
      onExit: ['log'],
    },
    'polish-implement': {
      id: 'polish-implement',
      type: 'atomic',
      parent: 'polish-track',
    },
    'polish-validate': {
      id: 'polish-validate',
      type: 'atomic',
      parent: 'polish-track',
    },
    'polish-update-docs': {
      id: 'polish-update-docs',
      type: 'atomic',
      parent: 'polish-track',
    },

    // Overhaul track compound
    'overhaul-track': {
      id: 'overhaul-track',
      type: 'compound',
      initial: 'overhaul-plan',
      maxFixCycles: 3,
      onEntry: ['log'],
      onExit: ['log'],
    },
    'overhaul-plan': {
      id: 'overhaul-plan',
      type: 'atomic',
      parent: 'overhaul-track',
    },
    'overhaul-delegate': {
      id: 'overhaul-delegate',
      type: 'atomic',
      parent: 'overhaul-track',
    },
    'overhaul-review': {
      id: 'overhaul-review',
      type: 'atomic',
      parent: 'overhaul-track',
    },
    'overhaul-update-docs': {
      id: 'overhaul-update-docs',
      type: 'atomic',
      parent: 'overhaul-track',
    },

    synthesize: { id: 'synthesize', type: 'atomic' },
    completed: { id: 'completed', type: 'final' },
    cancelled: { id: 'cancelled', type: 'final' },
    blocked: { id: 'blocked', type: 'atomic' },
  };

  const transitions: Transition[] = [
    { from: 'explore', to: 'brief', guard: guards.scopeAssessmentComplete },

    // Brief -> polish or overhaul
    {
      from: 'brief',
      to: 'polish-implement',
      guard: guards.polishTrackSelected,
    },
    { from: 'brief', to: 'overhaul-plan', guard: guards.overhaulTrackSelected },

    // Polish track flow
    {
      from: 'polish-implement',
      to: 'polish-validate',
      guard: guards.implementationComplete,
    },
    {
      from: 'polish-validate',
      to: 'polish-update-docs',
      guard: guards.goalsVerified,
    },
    { from: 'polish-update-docs', to: 'completed', guard: guards.docsUpdated },

    // Overhaul track flow
    {
      from: 'overhaul-plan',
      to: 'overhaul-delegate',
      guard: guards.planArtifactExists,
    },
    {
      from: 'overhaul-delegate',
      to: 'overhaul-review',
      guard: guards.allTasksComplete,
    },
    {
      from: 'overhaul-review',
      to: 'overhaul-update-docs',
      guard: guards.allReviewsPassed,
    },
    {
      from: 'overhaul-review',
      to: 'overhaul-delegate',
      guard: guards.anyReviewFailed,
      isFixCycle: true,
      effects: ['increment-fix-cycle'],
    },
    { from: 'overhaul-update-docs', to: 'synthesize', guard: guards.docsUpdated },

    // Synthesize -> completed
    { from: 'synthesize', to: 'completed', guard: guards.prUrlExists },
  ];

  return { id: 'refactor', states, transitions };
}
