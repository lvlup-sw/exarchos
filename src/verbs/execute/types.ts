// ─── Bounded action executor: the compiled form and its refusals ────────────
//
// `execute_intent` takes a NAMED intent and nothing else. The caller can never
// hand in an action array, so everything the executor will run has to be
// derived from a runbook the repository already declares. That derivation is
// the compiler, and `CompiledSegment` is what it produces.
//
// CompiledSegment is an INTERIM executable form, and deliberately private to
// this directory. There is no second intermediate representation in this tree
// to lower it into yet; lowering is deferred until the shared kernel that owns
// that representation exists (`lvlup-sw/strategos#193`). Nothing outside
// `verbs/execute/` should grow a dependency on this shape, because a later
// lowering would then have to preserve it rather than replace it.

import type { BundleRefV1 } from '../../events/bundle/digest-references.js';
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
  /**
   * The stream this leaf's declared emissions and postconditions are OBSERVED
   * on, resolved at compile time from the leaf's arguments and its contract.
   * Usually the segment's own stream; not always, because a leaf whose records
   * land on a shared infrastructure stream cannot be checked against a stream
   * it never writes to.
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
   * A step names something this process cannot invoke: a `native:` tool (an
   * agent-side tool with no registry schema and no local handler), or a
   * registered action absent from the handler table the leaves run through.
   * Either way the segment is not closed over what this process can execute,
   * and the refusal is owed BEFORE the first leaf rather than mid-flight —
   * a segment that stops after its irreversible step has already run is the
   * outcome this code exists to prevent.
   */
  | 'INTENT_NOT_CLOSED'
  /**
   * A step would be checked against a handler table, but the compile deps
   * name no tool that table belongs to. A table's keys alone cannot say which
   * tool minted them, and an unnamed owner cannot be trusted to be the step's
   * own tool — so compilation refuses rather than assuming it.
   */
  | 'INTENT_HANDLER_TABLE_UNOWNED'
  /**
   * A step names a tool that disagrees with the handler table's declared
   * owner. Registered and local is not the same as invokable through THIS
   * table: an action name that happens to collide with one in the table would
   * otherwise resolve the step's declaration correctly and then run the wrong
   * tool's handler for it.
   */
  | 'INTENT_HANDLER_TOOL_MISMATCH'
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
  | 'INTENT_LEAF_ARGS_INVALID'
  /**
   * A step passes a `<var>` placeholder the validated args have no binding for.
   * The runbook's reference is what makes the variable required; dropping the
   * placeholder instead would run the leaf without the value the step exists to
   * hand it, and a gate routed by that value would then assess nothing.
   */
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

/** Per-leaf outcome after the runbook failure policy has been applied. */
export type LeafStatus = 'passed' | 'failed' | 'advisory-failed';

/**
 * What one leaf appended, as the store confirmed it.
 *
 * `streamId` is part of the fact, not decoration: a sequence numbers a position
 * within ONE stream, and a leaf whose contract says its records land on a
 * shared infrastructure stream reports positions from that stream while the
 * receipt's `tailSequence` stays the subject stream's. The pair is what a
 * caller can resolve; the number alone is ambiguous across the two.
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
   * Present when this leaf returned success without the events its own
   * registration promises unconditionally, AND the resolved emission
   * enforcement mode chose not to halt the segment for it. Carried here so an
   * advisory mode still reports the finding — suppressing it to keep an
   * advisory run quiet would lose it entirely, since the segment commits.
   */
  readonly emissionViolation?: 'INTENT_EMISSION_CONTRACT_VIOLATED';
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
 * The interaction economy this action can honestly measure. `deferred` names the
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
 *
 * A committed receipt advertises NO follow-up verbs, and that is a stated
 * limitation rather than an oversight. The envelope's next-action derivation
 * recognizes exactly two payload shapes, and both are full workflow-STATE
 * reads: the transitions it computes are only as sound as the facts it was
 * handed, and a payload that carries a phase and a workflow type without the
 * artifacts, tasks, reviews and evidence beside them yields topology with no
 * admission behind it — legal-looking moves the log would refuse. Adding those
 * two fields alone would put a receipt into the state-read lane on the strength
 * of two keys; carrying the whole snapshot would make the receipt a state read,
 * which is a different object with a different owner. So a caller reads the
 * receipt for what this operation did and asks the workflow surface what to do
 * next.
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
  /**
   * The run bundle this operation's interior was written to — the per-leaf
   * trace behind the compact `leaves` above — as (artifact id, digest) pairs
   * the run-bundle store resolves. Written BEFORE the operation record that
   * names it, so a receipt that carries a reference carries one whose bytes
   * were durable when the claim committed.
   *
   * Optional on the type for exactly one reason: a receipt persisted in an
   * operation claim before custody existed has no reference, and a replay of
   * that operation hands the caller that receipt verbatim. Every receipt the
   * executor commits today carries at least one.
   */
  readonly bundleRefs?: readonly BundleRefV1[];
}

/** Refusals the executor itself raises, after compilation and before or during execution. */
export type ExecuteRefusalCode =
  /** The operation id is already claimed for a DIFFERENT request. */
  | 'INTENT_REPLAY_DIGEST_MISMATCH'
  /** A leaf whose failure policy is `stop` reported failure. */
  | 'INTENT_SEGMENT_FAILED'
  /** A leaf completed without the events its own registration declares unconditionally. */
  | 'INTENT_EMISSION_CONTRACT_VIOLATED';
