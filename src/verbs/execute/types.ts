// ─── Bounded action executor: the compiled form and its refusals ────────────
//
// `execute_intent` takes a NAMED intent and nothing else. The caller can never
// hand in an action array, so everything the executor will run has to be
// derived from a runbook the repository already declares. That derivation is
// the compiler, and `CompiledSegment` is what it produces.
//
// CompiledSegment is an INTERIM executable form, and deliberately private to
// this directory. There is no workflow-builder intermediate representation in
// this tree to lower it into yet; lowering is deferred until one exists
// (lvlup-sw/exarchos#1258). Nothing outside `verbs/execute/` should grow a
// dependency on this shape, because a later lowering would then have to
// preserve it rather than replace it.

import type { ActionContract, ToolAction } from '../../registry.js';

/**
 * One runbook step resolved to a registered action, with the arguments it will
 * be invoked with already accepted by that action's own registered schema.
 * A leaf reaching the executor has nothing left to validate.
 */
export interface CompiledLeaf {
  /** Zero-based position in the segment; part of the leaf's derived operation id. */
  readonly index: number;
  /** Composite tool the action is registered under. */
  readonly tool: string;
  /** Registered action name. */
  readonly action: string;
  /** Failure policy carried over from the runbook step. `retry` never compiles. */
  readonly onFail: 'stop' | 'continue';
  /** Arguments as the action's registered schema parsed them. */
  readonly args: Record<string, unknown>;
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
 * Why a named intent could not be turned into a segment. Every code below is a
 * refusal BEFORE any effect: the compiler runs to completion, or nothing runs.
 */
export type CompileRefusalCode =
  /** No runbook carries this id. */
  | 'INTENT_UNKNOWN'
  /** The runbook exists but declares no typed argument schema, so it is not executable here. */
  | 'INTENT_NOT_COMPILABLE'
  /** The caller's `args` did not satisfy the intent's typed argument schema. */
  | 'INTENT_ARGS_INVALID'
  /**
   * A step names a `native:` tool. Those are agent-side tools with no registry
   * schema and no local handler, so the segment is not closed over anything
   * this process can execute.
   */
  | 'INTENT_NOT_CLOSED'
  /**
   * A step is a decision point rather than a call — it names no tool and asks
   * the model or the host to choose. The obligation is the caller's to
   * discharge; the executor refuses rather than deciding on its behalf.
   */
  | 'INTENT_HOST_OBLIGATION'
  /** A step asks for `onFail: 'retry'`, which no execution policy here implements. */
  | 'INTENT_RETRY_UNSUPPORTED'
  /** A step names an action no registered composite tool declares. */
  | 'INTENT_ACTION_UNREGISTERED'
  /** A step's action is not locally executable — a host-owned or contract-less action. */
  | 'INTENT_ACTION_NOT_LOCAL'
  /** The arguments built for a leaf were rejected by that leaf's registered schema. */
  | 'INTENT_LEAF_ARGS_INVALID';

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

/** Per-leaf outcome after the runbook failure policy has been applied. */
export type LeafStatus = 'passed' | 'failed' | 'advisory-failed';

/** What one leaf appended, as the store confirmed it. */
export interface ReceiptEvent {
  readonly type: string;
  readonly sequence: number;
}

export interface ReceiptLeaf {
  readonly action: string;
  readonly status: LeafStatus;
  readonly events: readonly ReceiptEvent[];
}

/**
 * Caller-supplied steering recorded verbatim. No durable per-task risk stamp
 * exists — the tier is derived from plan markdown at delegation time and only
 * the workflow-level maximum persists — so the provenance says `caller-args`
 * rather than implying a resolved fact the log could be asked for.
 */
export interface ReceiptSteering {
  readonly riskTier?: 'low' | 'medium' | 'high';
  readonly boundaryTouching?: boolean;
  readonly source: 'caller-args';
}

/**
 * The interaction economy this slice can honestly measure. `deferred` names the
 * fields a fuller accounting owes and this one does not attempt, so a reader
 * cannot mistake an absent field for a measured zero.
 */
export interface ReceiptInteraction {
  readonly leavesExecuted: number;
  readonly eventsAppended: number;
  readonly requests: number;
  readonly deferred: readonly string[];
}

/**
 * What the caller gets back, and what a later replay of the same operation id
 * returns verbatim. Stored as the operation claim's canonical result, so the
 * committing call and every retry after it hand back the same object.
 */
export interface IntentReceipt {
  readonly operationId: string;
  readonly intent: string;
  readonly outcome: 'committed' | 'failed';
  readonly leaves: readonly ReceiptLeaf[];
  readonly failedLeaf?: string;
  /** Highest store sequence this segment's leaves reached; 0 when none appended. */
  readonly tailSequence: number;
  readonly requestDigest: string;
  readonly steering?: ReceiptSteering;
  /**
   * Why the segment halted, present only when it did. Carried ON the receipt
   * rather than only in the returned envelope so a replay of a failed
   * operation reproduces the same refusal it produced the first time — the
   * claim stores the receipt, and nothing else survives the call.
   */
  readonly failure?: { readonly code: ExecuteRefusalCode; readonly message: string };
  readonly interaction: ReceiptInteraction;
}

/** Refusals the executor itself raises, after compilation and before or during execution. */
export type ExecuteRefusalCode =
  /** The operation id is already claimed for a DIFFERENT request. */
  | 'INTENT_REPLAY_DIGEST_MISMATCH'
  /** A leaf whose failure policy is `stop` reported failure. */
  | 'INTENT_SEGMENT_FAILED'
  /** A leaf completed without the events its own registration declares unconditionally. */
  | 'INTENT_EMISSION_CONTRACT_VIOLATED';
