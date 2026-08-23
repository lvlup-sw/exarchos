/**
 * A branch in a decision tree. Advisory — the agent reads and decides.
 */
export interface DecisionBranch {
  /** Human-readable label for this branch (e.g., "yes", "no", ">= 3") */
  readonly label: string;
  /** What to do if this branch is chosen */
  readonly guidance: string;
  /** Optional: jump to a specific step by id */
  readonly nextStep?: string;
  /** Optional: escalate to human if this branch is chosen */
  readonly escalate?: boolean;
}

/**
 * A decision point in a decision runbook. Advisory-only — the platform
 * provides structure, the agent makes the decision.
 */
export interface DecisionField {
  /** The question to answer at this decision point */
  readonly question: string;
  /** Where to get the answer: state field, gate result, event count, or human */
  readonly source: 'state-field' | 'gate-result' | 'event-count' | 'human';
  /** State field path or gate name (when source is 'state-field' or 'gate-result') */
  readonly field?: string;
  /** Decision branches keyed by answer value */
  readonly branches: Record<string, DecisionBranch>;
}

/**
 * Failure policy for a runbook step — ADVISORY, addressed to whoever runs the
 * chain. The runbook surface projects a plan and never dispatches a step, so
 * nothing on this side halts anything: 'stop' instructs the caller to skip the
 * remaining steps if this one fails, 'continue' to carry on regardless.
 *
 * There is deliberately no 'retry' arm. It was declared by no step and no
 * reader could have honored it, so it is rejected rather than accepted into a
 * projection that would imply a retry someone performs.
 */
export type StepFailurePolicy = 'stop' | 'continue';

/**
 * A single step in a runbook sequence.
 * Tools prefixed with 'native:' (e.g., 'native:Task') represent Claude Code
 * native tools — their schemas are not resolved from the MCP registry.
 */
export interface RunbookStep {
  /** Tool name (e.g., 'exarchos_orchestrate') or 'native:Task' for native tools */
  readonly tool: string;
  /** Action name within the tool */
  readonly action: string;
  /** Advisory failure policy — see {@link StepFailurePolicy}; nothing here enforces it */
  readonly onFail: StepFailurePolicy;
  /** Static params to pre-fill (agent fills the rest from templateVars) */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Human-readable note for this step */
  readonly note?: string;
  /** Decision point — advisory structure for the agent to follow */
  readonly decide?: DecisionField;
}

/**
 * A runbook defines an ordered sequence of tool calls for a workflow operation.
 * Runbooks reference actions by name — schemas are resolved from the registry
 * at serve-time, preventing schema drift.
 */
export interface RunbookDefinition {
  /** Unique identifier (e.g., 'task-completion') */
  readonly id: string;
  /** Workflow phase this runbook applies to */
  readonly phase: string;
  /** Human-readable description */
  readonly description: string;
  /** Ordered steps */
  readonly steps: readonly RunbookStep[];
  /** Variables the agent must supply (resolved from context) */
  readonly templateVars: readonly string[];
  /** Events auto-emitted by the steps (agent should NOT manually emit these) */
  readonly autoEmits: readonly string[];
}

/**
 * A runbook step with resolved schema and metadata from the registry.
 * This is what the agent receives when requesting a runbook in detail mode.
 */
export interface ResolvedRunbookStep {
  /** Step sequence number (1-based) */
  readonly seq: number;
  readonly tool: string;
  readonly action: string;
  /** Advisory failure policy — see {@link StepFailurePolicy}; the agent applies it, not Exarchos */
  readonly onFail: StepFailurePolicy;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly note?: string;
  /** JSON Schema resolved from registry (null for native: tools) */
  readonly schema?: unknown;
  /** Action description from registry */
  readonly description?: string | undefined;
  /** Gate metadata from registry (null if not a gate action) */
  readonly gate?: { readonly blocking: boolean; readonly dimension?: string } | null;
  /** Platform-specific hints for native steps that reference agent specs */
  readonly platformHint?: { readonly claudeCode: string; readonly generic: string };
  /** Decision point — advisory structure for the agent to follow */
  readonly decide?: DecisionField;
}
