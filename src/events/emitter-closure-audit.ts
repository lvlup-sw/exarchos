/**
 * Is every append in the tree explained by something that declares it?
 *
 * ── Why a closure check and not another census ──────────────────────────────
 *
 * Two declaration surfaces name emitters: an action's `autoEmits`, and
 * {@link MODULE_EMISSIONS} for emitters that are not actions. Each can be
 * checked for internal consistency and still leave the important question
 * unanswered, because both only describe what somebody wrote down.
 *
 * The measured append-site census answers the other direction. Comparing the
 * two makes the accounting TOTAL:
 *
 *   • `UNDECLARED_APPEND_SITE` — the tree appends an event that neither surface
 *     claims. This is the direction a declaration table can never find on its
 *     own, and it is where the real gap lives.
 *   • `PHANTOM_MODULE_EMISSION` — a declared module emitter whose append is not
 *     in the tree. Same no-stale-cover ratchet the rest of this layer uses: a
 *     declaration that outlives its subject is a claim the tree does not
 *     support, and it would otherwise sit there looking like coverage.
 *
 * Both arms matter and neither substitutes for the other. Only the first tells
 * you the model is incomplete; only the second tells you the model is stale.
 *
 * ── The scan root is part of the verdict ────────────────────────────────────
 *
 * The census reads the governed source tree. A declared emitter OUTSIDE that
 * root cannot be confirmed or refuted by it, so such a row is reported as
 * {@link UnverifiableModuleEmission} rather than silently accepted — "the
 * census could not look here" and "the census looked and agreed" are different
 * answers, and collapsing them is how a scan under-reports while appearing
 * complete.
 */

import { TOOL_REGISTRY, normalizeActionContract, type CompositeTool } from '../registry.js';
import type { AppendSiteCensus } from './append-site-census.js';
import type { EmissionEdge } from './registration-validate.js';
import { MODULE_EMISSIONS, type ModuleEmission } from './module-emissions.js';

/** An append the tree performs that no declaration surface claims. */
export interface UndeclaredAppendSite {
  readonly code: 'UNDECLARED_APPEND_SITE';
  readonly event: string;
  /** The module performing the unexplained append. */
  readonly module: string;
  readonly message: string;
}

/** A declared module emitter whose append site is not in the tree. */
export interface PhantomModuleEmission {
  readonly code: 'PHANTOM_MODULE_EMISSION';
  readonly event: string;
  readonly module: string;
  readonly message: string;
}

/** A declared module emitter the census could not reach. */
export interface UnverifiableModuleEmission {
  readonly event: string;
  readonly module: string;
  readonly reason: 'outside-scan-root';
}

export interface EmitterClosureResult {
  /** Every measured append is claimed, and every claim is live. */
  readonly ok: boolean;
  /** Distinct measured append sites considered — the DENOMINATOR. */
  readonly measuredSiteCount: number;
  /** Sites explained by an action's `autoEmits`. */
  readonly explainedByAction: number;
  /** Sites explained by a {@link MODULE_EMISSIONS} row. */
  readonly explainedByModule: number;
  readonly undeclared: readonly UndeclaredAppendSite[];
  readonly phantoms: readonly PhantomModuleEmission[];
  readonly unverifiable: readonly UnverifiableModuleEmission[];
}

/** `event → the modules declared to append it` from the non-action surface. */
function moduleIndex(rows: readonly ModuleEmission[]): ReadonlyMap<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>();
  for (const row of rows) {
    const modules = index.get(row.event) ?? new Set<string>();
    modules.add(row.module);
    index.set(row.event, modules);
  }
  return index;
}

/**
 * Reconcile the measured append sites against both declaration surfaces. Pure
 * and total: returns a verdict, never throws.
 *
 * An action edge explains EVERY site for its event rather than a particular
 * module. That is deliberate and it is the honest limit of the action surface:
 * `autoEmits` names an action, never a file, so it cannot say which of two
 * modules performed the append. Claiming otherwise would invent precision the
 * declaration does not carry — the provider-area audit is where an event
 * appended from somewhere unexpected is caught.
 */
export function auditEmitterClosure(
  census: AppendSiteCensus,
  actionEdges: readonly EmissionEdge[],
  moduleEmissions: readonly ModuleEmission[] = MODULE_EMISSIONS,
): EmitterClosureResult {
  const declaredByAction = new Set(actionEdges.map((edge) => edge.event));
  const declaredByModule = moduleIndex(moduleEmissions);

  const undeclared: UndeclaredAppendSite[] = [];
  let measuredSiteCount = 0;
  let explainedByAction = 0;
  let explainedByModule = 0;

  for (const [event, modules] of census.modulesByEvent) {
    for (const module of modules) {
      measuredSiteCount += 1;
      if (declaredByAction.has(event)) {
        explainedByAction += 1;
        continue;
      }
      if (declaredByModule.get(event)?.has(module) === true) {
        explainedByModule += 1;
        continue;
      }
      undeclared.push({
        code: 'UNDECLARED_APPEND_SITE',
        event,
        module,
        message:
          `'${module}' appends '${event}', and nothing declares that it does: no action lists the ` +
          'event in its `autoEmits`, and no module-emission row names this site. Either the append ' +
          'is an action\'s effect and the action should declare it, or it is performed by a ' +
          'wrapper, hook or interceptor and belongs in the non-action surface with the mechanism ' +
          'stated. An append nobody claims is one no check downstream can see.',
      });
    }
  }

  const phantoms: PhantomModuleEmission[] = [];
  const unverifiable: UnverifiableModuleEmission[] = [];
  for (const row of moduleEmissions) {
    const measured = census.modulesByEvent.get(row.event);
    if (measured?.includes(row.module) === true) continue;
    // A row whose module the census never scanned is unanswered, not refuted.
    if (!census.scannedModules.includes(row.module)) {
      unverifiable.push({ event: row.event, module: row.module, reason: 'outside-scan-root' });
      continue;
    }
    phantoms.push({
      code: 'PHANTOM_MODULE_EMISSION',
      event: row.event,
      module: row.module,
      message:
        `the non-action surface declares that '${row.module}' appends '${row.event}', and the ` +
        'census finds no such append in that module. The reasoning was about one measured fact ' +
        'and that fact is gone — the append moved, was deleted, or its type stopped resolving. ' +
        'Delete the row or follow the append: a declaration that outlives its subject reads as ' +
        'coverage while covering nothing.',
    });
  }

  const byEvent = (
    a: { event: string; module: string },
    b: { event: string; module: string },
  ): number => a.event.localeCompare(b.event) || a.module.localeCompare(b.module);

  return Object.freeze({
    ok: undeclared.length === 0 && phantoms.length === 0,
    measuredSiteCount,
    explainedByAction,
    explainedByModule,
    undeclared: Object.freeze([...undeclared].sort(byEvent)),
    phantoms: Object.freeze([...phantoms].sort(byEvent)),
    unverifiable: Object.freeze([...unverifiable].sort(byEvent)),
  });
}

// ─── The action arm: attribution, not just anonymity ────────────────────────
//
// The closure above indexes declared edges by event NAME alone, which is the
// honest limit of that comparison — an edge names an action, never a file. The
// consequence is that an action which reasons "I emit nothing" while a module it
// reaches appends a catalog event shows up only as one more anonymous undeclared
// row. The row says a file appends something unexplained; it cannot say WHO
// should have explained it, and the reasoned abstention that is actually wrong
// reads as innocent.
//
// This arm supplies the missing side. It needs one fact the declarations do not
// carry: which appends an action answers for.
//
// ── Why ownership is declared here rather than derived ──────────────────────
//
// The action-to-handler-module correspondence exists only inside the composite
// routers' closures (a handler table entry, plus the import that binds the
// identifier). It is code, not data — the same obstacle that forced the
// reachability layer to SOURCE-SCAN its routers, and that scan resolves action
// NAMES, not the modules behind them. Deriving it here would mean a second
// scanner, and a one-hop import walk would attribute every append in a handler's
// neighbourhood to it, which invents ownership rather than measuring it.
//
// So the relation is written down — and then held to the tree in BOTH
// directions, the same posture {@link MODULE_EMISSIONS} carries. A row naming an
// append the census does not see is stale and reported; a row whose append no
// registry edge backs is reported; and a row whose action declares a reasoned
// `none` is reported under its own code, with the reason quoted, because that
// one is a false statement rather than an omission.
//
// Rows are event-SCOPED on purpose. A module-wide claim would hand an action
// every append in the file, including ones nothing on its path reaches — which
// is how `verbs/team/dispatch-guard.ts` used to read, back when a second,
// uninvoked emitter still sat beside the stash probe `prepare_delegation` does
// reach.

/** An append an action answers for: the module that performs it, and the event. */
export interface ActionAppendOwnership {
  /** The registered action accountable for the append. */
  readonly action: string;
  /** The module performing it, relative to the scan root, forward-slashed. */
  readonly module: string;
  /** The event type appended there. */
  readonly event: string;
  /** The wiring a reader can follow from the action's handler to this append. */
  readonly wiring: string;
}

/** An action that declared a reasoned `none` on its emission axis. */
export interface ActionAbstention {
  readonly action: string;
  readonly because: string;
}

/** An owned append that no registry edge from the owning action backs. */
export interface UnbackedOwnedAppend {
  readonly code: 'UNDECLARED_ACTION_OWNED_APPEND';
  readonly action: string;
  readonly event: string;
  readonly module: string;
  readonly message: string;
}

/** An owning action that reasons it emits nothing while the tree says otherwise. */
export interface FalseReasonedAbstention {
  readonly code: 'FALSE_REASONED_ABSTENTION';
  readonly action: string;
  readonly event: string;
  readonly module: string;
  /** The reason the action gave for emitting nothing. */
  readonly because: string;
  readonly message: string;
}

/** An ownership row the census cannot confirm. */
export interface StaleAppendOwnership {
  readonly code: 'STALE_APPEND_OWNERSHIP';
  readonly action: string;
  readonly event: string;
  readonly module: string;
  readonly reason: 'module-not-scanned' | 'append-not-in-module';
  readonly message: string;
}

export interface ActionOwnedAppendAudit {
  /** Every ownership row is live, backed, and made by an action that admits to it. */
  readonly ok: boolean;
  /** Ownership rows the census CONFIRMED — the DENOMINATOR. */
  readonly confirmedOwnedAppends: number;
  /** Actions declaring a reasoned `none` — the population the rows are joined against. */
  readonly abstainingActions: number;
  readonly unbacked: readonly UnbackedOwnedAppend[];
  readonly falseAbstentions: readonly FalseReasonedAbstention[];
  readonly stale: readonly StaleAppendOwnership[];
}

/**
 * Every registered action whose contract reasons that it emits nothing.
 *
 * Reads the registry as a VALUE, exactly as the edge flattener does. An action
 * whose contract cannot be normalized contributes nothing: an unreadable
 * declaration is an unanswered question, not an abstention.
 */
export function reasonedAbstentions(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): readonly ActionAbstention[] {
  const abstentions: ActionAbstention[] = [];
  for (const tool of registry) {
    for (const action of tool.actions) {
      const raw = Reflect.get(action, 'actionContract');
      if (raw === undefined) continue;
      try {
        const contract = normalizeActionContract(raw);
        if (contract.emissions.kind === 'none') {
          abstentions.push({ action: action.name, because: contract.emissions.because });
        }
      } catch {
        continue;
      }
    }
  }
  return Object.freeze(abstentions.sort((a, b) => a.action.localeCompare(b.action)));
}

/**
 * The appends the actions in this tree answer for.
 *
 * A row leaves when its append leaves; a row arrives when an append is traced to
 * the action that reaches it. Every row states the wiring, so the claim is
 * checkable by reading two files.
 */
export const ACTION_APPEND_OWNERSHIP: readonly ActionAppendOwnership[] = Object.freeze([
  {
    action: 'create_pr',
    module: 'verbs/vcs/create-pr.ts',
    event: 'pr.create.requested',
    wiring: 'the create-PR handler journals intent before the provider call',
  },
  {
    action: 'create_pr',
    module: 'verbs/vcs/create-pr.ts',
    event: 'pr.create.executed',
    wiring: 'the create-PR handler journals the result after the provider call',
  },
  {
    action: 'create_issue',
    module: 'verbs/vcs/create-issue.ts',
    event: 'issue.create.requested',
    wiring: 'the create-issue handler journals intent before the provider call',
  },
  {
    action: 'create_issue',
    module: 'verbs/vcs/create-issue.ts',
    event: 'issue.create.executed',
    wiring: 'the create-issue handler journals the result after the provider call',
  },
  {
    action: 'add_pr_comment',
    module: 'verbs/vcs/add-pr-comment.ts',
    event: 'pr.comment.executed',
    wiring: 'the comment handler journals the result on each of its three terminal paths',
  },
  {
    action: 'merge_orchestrate',
    module: 'verbs/merge/execute-merge.ts',
    event: 'merge.executing_started',
    wiring: 'the orchestrator delegates to the executor, which marks the executing phase',
  },
  {
    action: 'merge_orchestrate',
    module: 'verbs/merge/execute-merge.ts',
    event: 'merge.retry_attempt',
    wiring: 'the executor retry hook records each timeout retry',
  },
  {
    action: 'assess_stack',
    module: 'verbs/vcs/assess-stack.ts',
    event: 'provider.parse-error',
    wiring: 'the stack assessor records a review adapter that threw while parsing',
  },
  {
    action: 'assess_stack',
    module: 'verbs/vcs/assess-stack.ts',
    event: 'provider.unknown-tier',
    wiring: 'the stack assessor records a parsed item whose tier the adapter does not know',
  },
  {
    action: 'prune_stale_workflows',
    module: 'verbs/team/prune-stale-workflows.ts',
    event: 'prune.diagnostics',
    wiring: 'the prune evaluation writes its own audit line, fire-and-forget',
  },
  {
    action: 'cancel',
    module: 'workflow/compensation.ts',
    event: 'branch.delete.requested',
    wiring: 'cancel is the sole caller of the compensation saga, whose branch compensator journals intent',
  },
  {
    action: 'cancel',
    module: 'workflow/compensation.ts',
    event: 'branch.delete.executed',
    wiring: 'cancel is the sole caller of the compensation saga, whose branch compensator journals the result',
  },
  {
    action: 'prepare_review',
    module: 'verbs/team/prepare-review.ts',
    event: 'workflow.plan-review-dispatched',
    wiring: 'the plan scope counts each dispatch at the provisioning seam',
  },
  {
    action: 'classify_review_items',
    module: 'verbs/review/classify-review-items.ts',
    event: 'dispatch.classified',
    wiring: 'the classifier records the grouping, best-effort',
  },
  {
    action: 'prepare_delegation',
    module: 'verbs/team/dispatch-guard.ts',
    event: 'stash.detected',
    wiring: 'the delegation handler calls the stash probe',
  },
]);

/**
 * Reconcile the owned appends against the tree, the registry, and the actions'
 * own abstentions. Pure and total: returns a verdict, never throws.
 *
 * Three independent faults, reported together. `stale` says the ownership claim
 * has outlived its subject; `unbacked` says the action owns an append it never
 * declared; `falseAbstentions` is the subset of `unbacked` where the action did
 * not merely omit the edge but positively reasoned that there was none.
 */
export function auditActionOwnedAppends(
  census: AppendSiteCensus,
  actionEdges: readonly EmissionEdge[],
  abstentions: readonly ActionAbstention[] = reasonedAbstentions(),
  ownership: readonly ActionAppendOwnership[] = ACTION_APPEND_OWNERSHIP,
): ActionOwnedAppendAudit {
  const declaredByAction = new Set(actionEdges.map((edge) => `${edge.action} ${edge.event}`));
  const abstentionBy = new Map(abstentions.map((row) => [row.action, row.because]));

  const unbacked: UnbackedOwnedAppend[] = [];
  const falseAbstentions: FalseReasonedAbstention[] = [];
  const stale: StaleAppendOwnership[] = [];
  let confirmed = 0;

  for (const row of ownership) {
    // A module the census never read can neither confirm nor refute the row —
    // the same distinction the module arm draws, for the same reason.
    if (!census.scannedModules.includes(row.module)) {
      stale.push({
        code: 'STALE_APPEND_OWNERSHIP',
        action: row.action,
        event: row.event,
        module: row.module,
        reason: 'module-not-scanned',
        message:
          `'${row.action}' is declared to answer for '${row.event}' in '${row.module}', and the ` +
          'census never read that module. The path is wrong, or the module left the scanned tree; ' +
          'either way the claim rests on a file nothing measured.',
      });
      continue;
    }
    if (census.modulesByEvent.get(row.event)?.includes(row.module) !== true) {
      stale.push({
        code: 'STALE_APPEND_OWNERSHIP',
        action: row.action,
        event: row.event,
        module: row.module,
        reason: 'append-not-in-module',
        message:
          `'${row.action}' is declared to answer for '${row.event}' in '${row.module}', and the ` +
          'census finds no such append there. Follow the append or delete the row: an ownership ' +
          'claim over an append that is gone attributes nothing while looking like attribution.',
      });
      continue;
    }

    confirmed += 1;
    if (declaredByAction.has(`${row.action} ${row.event}`)) continue;

    const because = abstentionBy.get(row.action);
    if (because !== undefined) {
      falseAbstentions.push({
        code: 'FALSE_REASONED_ABSTENTION',
        action: row.action,
        event: row.event,
        module: row.module,
        because,
        message:
          `'${row.action}' declares that it emits nothing — "${because}" — while '${row.module}', ` +
          `which it reaches, appends '${row.event}'. A reasoned abstention is a statement about ` +
          'the tree, and this one is false. It is worse than a missing edge: an omission reads as ' +
          'unfinished, a wrong reason reads as settled.',
      });
      continue;
    }
    unbacked.push({
      code: 'UNDECLARED_ACTION_OWNED_APPEND',
      action: row.action,
      event: row.event,
      module: row.module,
      message:
        `'${row.action}' answers for the append of '${row.event}' in '${row.module}' and declares ` +
        'no edge for it. The event is this action\'s effect, so the action is where it belongs — ' +
        'an append attributed to nobody is one no downstream check can hold anyone to.',
    });
  }

  const byRow = (
    a: { action: string; event: string },
    b: { action: string; event: string },
  ): number => a.action.localeCompare(b.action) || a.event.localeCompare(b.event);

  return Object.freeze({
    ok: unbacked.length === 0 && falseAbstentions.length === 0 && stale.length === 0,
    confirmedOwnedAppends: confirmed,
    abstainingActions: abstentions.length,
    unbacked: Object.freeze([...unbacked].sort(byRow)),
    falseAbstentions: Object.freeze([...falseAbstentions].sort(byRow)),
    stale: Object.freeze([...stale].sort(byRow)),
  });
}
