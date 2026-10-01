/**
 * A branch in a decision tree. Advisory — the agent reads and decides.
 */
export interface DecisionBranch {
  /** Human-readable label for this branch, for example "yes", "no" or ">= 3". */
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
 * One step in a runbook. A `native:` tool, for example `native:Task`, is a Claude Code native
 * tool, and the registry does not resolve its schema.
 */
export interface RunbookStep {
  /** Tool name, for example `exarchos_orchestrate` or `native:Task`. */
  readonly tool: string;
  /** Action name within the tool */
  readonly action: string;
  /**
   * Advice to the agent when the step fails: `stop` halts the sequence, `continue` goes on, and
   * `retry` retries once. No executor reads this field.
   */
  readonly onFail: 'stop' | 'continue' | 'retry';
  /** Static params to pre-fill (agent fills the rest from templateVars) */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Human-readable note for this step */
  readonly note?: string;
  /** Decision point — advisory structure for the agent to follow */
  readonly decide?: DecisionField;
}

/**
 * An ordered sequence of tool calls for a workflow operation. Steps name their actions, and the
 * handler resolves each schema from the registry when it serves the runbook.
 */
export interface RunbookDefinition {
  /** Unique identifier, for example `task-completion`. */
  readonly id: string;
  /** Workflow phase this runbook applies to */
  readonly phase: string;
  /** Human-readable description */
  readonly description: string;
  /** Ordered steps */
  readonly steps: readonly RunbookStep[];
  /** Variables the agent must supply (resolved from context) */
  readonly templateVars: readonly string[];
  /** Events that the steps emit automatically. The agent must not emit them. */
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
  readonly onFail: 'stop' | 'continue' | 'retry';
  readonly params?: Readonly<Record<string, unknown>>;
  readonly note?: string;
  /** JSON Schema from the registry, or null for `native:` and decision steps. */
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
