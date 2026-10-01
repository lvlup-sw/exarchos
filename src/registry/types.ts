import type { DeclaredOutputSchema, ExtensionOutputSchema, RegisteredOutputSchema } from '../output-schema-declaration.js';
import type { AgentPosture } from '../runtime/agents/spec.js';
import { z } from 'zod';
import type { ActionContract } from './action-contract.js';
import type { ActionAnnotations } from './annotations.js';
import type { GateMetadata } from './gate-metadata.js';
import type { CliActionHints, CliToolHints, DispatchHints, EconomyHints } from './hints.js';

export interface ToolAction {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly phases: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
  readonly cli?: CliActionHints;
  readonly gate?: GateMetadata;
  /**
   * The action contract. The declaration types require it, but this consumer type keeps it optional for fixtures.
   * Load and registration never admit an action without the block.
   */
  readonly actionContract?: ActionContract;
  /**
   * Advisory dispatch metadata. It is not under `cli`, because the CLI and MCP facades share the dispatch core.
   * `exarchos_view describe` shows it, so clients can list task-suitable actions.
   */
  readonly dispatch?: DispatchHints;
  /**
   * Response-economy metadata: the token budget, with an optional summarizer. Both facades share it.
   * Without it, the action gets {@link DEFAULT_ECONOMY_BUDGET_TOKENS}. {@link resolveEconomyBudget} gives the number.
   */
  readonly economy?: EconomyHints;
  /**
   * True when the action can take several seconds. The CLI adapter then writes stderr heartbeats under `--json`.
   * MCP hosts render progress on their own and ignore this flag.
   */
  readonly longRunning?: boolean;
  /** True when the action is due for removal. `describe` shows it, so agents can move to the canonical action. */
  readonly deprecated?: boolean;
  /**
   * The trust-tier posture of the handler. When present, the capability resolver takes write capabilities from the posture table.
   * Without it, the resolver uses the annotation hints, which MCP does not trust.
   */
  readonly posture?: AgentPosture;
  /**
   * The typed Zod schema of the response envelope. Load-time `validateAction` also requires it.
   * This consumer field takes {@link RegisteredOutputSchema}, so built-in and `.exarchos.yml` tools share one action type.
   * The declaration types narrow it: {@link BuiltinToolAction} takes `DeclaredOutputSchema` only.
   *
   * `withCappedShape` makes a substantive schema. `vacuityWaiver` takes only an id from the vacuity allowlist.
   * So a new built-in action cannot declare a vacuous `outputSchema`. The `_OutputSchema*` proofs check this.
   */
  readonly outputSchema: RegisteredOutputSchema;
  /**
   * Marks the worktree surface actions, which span `exarchos_view` and `exarchos_orchestrate`.
   * A conformance harness finds the surface with this filter instead of a list of names.
   */
  readonly surface?: 'worktree';
  /**
   * Per-action annotations. The server trusts `safety`.
   * The four hint flags go to MCP clients through `tools/list`. The MCP spec makes them untrusted unless the server is trusted.
   */
  readonly annotations: ActionAnnotations;
}

/** A registry action with a complete {@link ActionContract}. {@link withActionContract} constructs it. */
export type ContractedToolAction = ToolAction & {
  readonly actionContract: ActionContract;
};

export interface CompositeTool {
  readonly name: string;
  readonly description: string;
  readonly actions: readonly ToolAction[];
  readonly cli?: CliToolHints;
  /** When true, the tool is excluded from MCP registration (not exposed to agents). CLI access is preserved. */
  readonly hidden?: boolean;
  /** One-line summary for slim MCP registration. Used when slimRegistration is enabled. */
  readonly slimDescription?: string;
}

/**
 * An action declared in {@link TOOL_REGISTRY}. Its `outputSchema` is a {@link DeclaredOutputSchema}.
 * Only `withCappedShape` and `vacuityWaiver` make that brand. `unregisteredActionOutputSchema` makes the extension brand, which does not fit here.
 * `TOOL_REGISTRY` is a `readonly BuiltinCompositeTool[]`, so that escape does not compile in the registry.
 */
export interface BuiltinToolAction extends ToolAction {
  readonly outputSchema: DeclaredOutputSchema;
  readonly actionContract: ActionContract;
}

/** Declaration shape before {@link withActionContract} attaches the block. */
export type BuiltinActionDraft = Omit<BuiltinToolAction, 'actionContract'>;

/** A composite tool whose actions are all built-in declarations. */
export interface BuiltinCompositeTool extends CompositeTool {
  readonly actions: readonly BuiltinToolAction[];
}

/**
 * An action declared outside the built-in registry: a `.exarchos.yml` custom tool or the oracle registration probe.
 * Its name is a runtime string, so it has no allowlist id to waive.
 * It is assignable to {@link ToolAction}, but not to {@link BuiltinToolAction}.
 */
export interface ExtensionToolAction extends ToolAction {
  readonly outputSchema: ExtensionOutputSchema;
  readonly actionContract: ActionContract;
}

/** Extension declaration shape before the contract block is attached. */
export type ExtensionActionDraft = Omit<ExtensionToolAction, 'actionContract'>;

/** A composite tool assembled from extension-declared actions. */
export interface ExtensionCompositeTool extends CompositeTool {
  readonly actions: readonly ExtensionToolAction[];
}
