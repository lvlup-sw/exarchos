/**
 * The compiled form of an intent and its refusals.
 * `execute_intent` takes a named intent, never an action list. Thus the executor runs only steps
 * that the compiler derives from a declared runbook. `CompiledSegment` is an interim form,
 * private to `verbs/execute/`. Code outside this directory must not depend on it, so that a later
 * lowering to `WorkflowDefinitionV1` can replace it.
 */

import type { BundleRefV1 } from '../../events/bundle/digest-references.js';
import type { ActionContract, ToolAction } from '../../registry.js';

/**
 * One runbook step, resolved to a registered action. The registered schema of the action
 * already accepted its arguments, so the executor has nothing left to validate.
 */
export interface CompiledLeaf {
  /** The zero-based position in the segment. The derived operation id of the leaf uses it. */
  readonly index: number;
  /** Composite tool the action is registered under. */
  readonly tool: string;
  /** Registered action name. */
  readonly action: string;
  /** Failure policy carried over from the runbook step. `retry` never compiles. */
  readonly onFail: 'stop' | 'continue';
  /** Arguments as the action's registered schema parsed them. */
  readonly args: Record<string, unknown>;
  /**
   * The stream where the checks observe the declared emissions and postconditions of this leaf.
   * The compiler resolves it from the arguments and the contract. It is usually the segment
   * stream, but a leaf that writes to a shared infrastructure stream is observed there.
   */
  readonly observationStreamId: string;
  /** The registry declaration — the source of the schema, contract and gate metadata. */
  readonly declaration: ToolAction;
  /** The declaration's normalized contract. Absent declarations never compile. */
  readonly contract: ActionContract;
}

/** An executable, fully-closed segment: every leaf is local and registered. */
export interface CompiledSegment {
  /** Runbook id this segment was compiled from. */
  readonly intent: string;
  /** Subject stream every leaf addresses. */
  readonly streamId: string;
  /** Validated typed intent arguments, as the intent's own schema parsed them. */
  readonly args: Record<string, unknown>;
  /** Leaves in runbook order. */
  readonly leaves: readonly CompiledLeaf[];
}

/**
 * Why a named intent did not compile. Each code is a refusal before any effect.
 * - `INTENT_NOT_COMPILABLE`: the runbook has no typed argument schema.
 * - `INTENT_NOT_CLOSED`: a step names a `native:` tool, or an action not in the handler table.
 * - `INTENT_HANDLER_TABLE_UNOWNED`: the compile deps name no owner tool for the handler table.
 * - `INTENT_HANDLER_TOOL_MISMATCH`: the step tool differs from the table owner.
 * - `INTENT_HOST_OBLIGATION`: a step is a decision point with no tool, and the caller decides.
 * - `INTENT_RETRY_UNSUPPORTED`: a step asks for `onFail: 'retry'`. The executor has no retry.
 * - `INTENT_ACTION_NOT_LOCAL`: the action has no contract, or its authority is not local.
 * - `INTENT_TEMPLATE_VAR_UNBOUND`: a step passes a `<var>` that has no binding.
 */
export type CompileRefusalCode =
  | 'INTENT_UNKNOWN'
  | 'INTENT_NOT_COMPILABLE'
  | 'INTENT_ARGS_INVALID'
  | 'INTENT_NOT_CLOSED'
  | 'INTENT_HANDLER_TABLE_UNOWNED'
  | 'INTENT_HANDLER_TOOL_MISMATCH'
  | 'INTENT_HOST_OBLIGATION'
  | 'INTENT_RETRY_UNSUPPORTED'
  | 'INTENT_ACTION_UNREGISTERED'
  | 'INTENT_ACTION_NOT_LOCAL'
  | 'INTENT_LEAF_ARGS_INVALID'
  | 'INTENT_TEMPLATE_VAR_UNBOUND';

/** A compile refusal, naming the step it is about wherever a step is at fault. */
export interface CompileRefusal {
  readonly code: CompileRefusalCode;
  readonly message: string;
  /** `<index>:<action>` of the offending step, when one step is responsible. */
  readonly step?: string;
}

export type CompileOutcome =
  | { readonly ok: true; readonly segment: CompiledSegment }
  | { readonly ok: false; readonly refusal: CompileRefusal };

/** The outcome of a leaf after the runbook failure policy applies. */
export type LeafStatus = 'passed' | 'failed' | 'advisory-failed';

/**
 * One event that a leaf appended, as the store confirmed it. A sequence is a position in one
 * stream, and a leaf can append to a shared infrastructure stream. Thus only the pair of
 * `streamId` and `sequence` identifies the event.
 */
export interface ReceiptEvent {
  readonly type: string;
  /** The stream the sequence belongs to — not always the segment's subject. */
  readonly streamId: string;
  readonly sequence: number;
}

export interface ReceiptLeaf {
  readonly action: string;
  readonly status: LeafStatus;
  readonly events: readonly ReceiptEvent[];
  /**
   * Set when the leaf returned success without the events that its registration always
   * promises, and the emission enforcement mode did not halt the segment. Thus an advisory
   * mode still reports the finding.
   */
  readonly emissionViolation?: 'INTENT_EMISSION_CONTRACT_VIOLATED';
}

/**
 * The steering of the segment, with its source. `caller-args` is the public executor path.
 * No durable per-task risk stamp exists, so the tier is the claim of the caller. `capsule` is
 * the settlement path, and the tier comes from the compiled capsule, not from the runtime.
 */
export interface ReceiptSteering {
  readonly riskTier?: 'low' | 'medium' | 'high';
  readonly boundaryTouching?: boolean;
  readonly source: 'caller-args' | 'capsule';
}

/**
 * The interaction economy that this action can measure. `deferred` names the fields that it
 * does not measure, so that an absent field does not read as a measured zero.
 */
export interface ReceiptInteraction {
  readonly leavesExecuted: number;
  readonly eventsAppended: number;
  readonly requests: number;
  readonly deferred: readonly string[];
}

/**
 * The result of an operation. The operation claim stores it, so a replay of the same
 * operation id returns the same object. A committed receipt advertises no follow-up verbs.
 * The envelope derives next actions only from full workflow-state reads, and a receipt is not
 * one. For the next step, the caller asks the workflow surface.
 */
export interface IntentReceipt {
  readonly operationId: string;
  readonly intent: string;
  readonly outcome: 'committed' | 'failed';
  readonly leaves: readonly ReceiptLeaf[];
  readonly failedLeaf?: string;
  /** The highest store sequence that the leaves reached, or 0 when they appended nothing. */
  readonly tailSequence: number;
  readonly requestDigest: string;
  readonly steering?: ReceiptSteering;
  /** Why the segment halted. It is on the receipt, so a replay of a failed operation returns the same refusal. */
  readonly failure?: { readonly code: ExecuteRefusalCode; readonly message: string };
  readonly interaction: ReceiptInteraction;
  /**
   * The run bundle that holds the per-leaf trace, as artifact id and digest pairs. The executor
   * writes the bundle before the operation record, so its bytes are durable when the claim commits.
   * It is optional because an older stored receipt can lack it, and a replay returns that
   * receipt verbatim.
   */
  readonly bundleRefs?: readonly [BundleRefV1, ...BundleRefV1[]];
}

/**
 * Refusals that the executor raises after compilation.
 * - `INTENT_REPLAY_DIGEST_MISMATCH`: the operation id is claimed for a different request.
 * - `INTENT_SEGMENT_FAILED`: a leaf with the failure policy `stop` reported failure.
 * - `INTENT_EMISSION_CONTRACT_VIOLATED`: a leaf completed without the events that its
 *   registration always declares.
 */
export type ExecuteRefusalCode =
  | 'INTENT_REPLAY_DIGEST_MISMATCH'
  | 'INTENT_SEGMENT_FAILED'
  | 'INTENT_EMISSION_CONTRACT_VIOLATED';
