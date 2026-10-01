/**
 * Checks that every append in the tree has a declaration, and every declaration has an append.
 *
 * Two surfaces declare emitters: the `autoEmits` of an action, and {@link MODULE_EMISSIONS}
 * for emitters that are not actions. The measured append-site census is the other side.
 *
 * - `UNDECLARED_APPEND_SITE`: the tree appends an event that no surface claims.
 * - `PHANTOM_MODULE_EMISSION`: a declared module emitter has no append in the tree.
 *
 * A declared emitter outside the scan root is {@link UnverifiableModuleEmission}, not accepted.
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

/** A declared module emitter that the census did not reach. */
export interface UnverifiableModuleEmission {
  readonly event: string;
  readonly module: string;
  readonly reason: 'outside-scan-root';
}

/** A declared action emission with no measured append site and no allowance covering it. */
export interface PhantomActionEmission {
  readonly code: 'PHANTOM_ACTION_EMISSION';
  readonly event: string;
  /** The qualified `tool.action` names declaring the event. */
  readonly declaredBy: readonly string[];
  readonly message: string;
}

/** An allowance row that does not describe the tree. */
export interface StaleUnresolvedAllowance {
  readonly code: 'STALE_UNRESOLVED_ALLOWANCE';
  readonly event: string;
  readonly reason: 'append-now-resolved' | 'no-declaring-edge';
  readonly message: string;
}

/** A declared action emission the census cannot confirm or refute. */
export interface UnverifiableActionEmission {
  readonly event: string;
  readonly reason: 'append-not-resolvable';
}

/**
 * Declared action emissions whose append site the census cannot resolve.
 *
 * Most of these events use an append with a runtime `type:` value, so the site is in
 * `unresolved` without an event name. The settlement records `orchestrate.intent_executed`
 * and `execution.settled` commit through `decideOnce`, which is not an `.append(...)`
 * call. The scan does not see them.
 *
 * SHRINK-ONLY. A row is stale when its append resolves, or when no edge declares the
 * event. Add a row only after you confirm that the parser cannot read the new append.
 */
export const UNRESOLVED_ACTION_EVENT_ALLOWANCE: readonly string[] = Object.freeze([
  'deviation.decided',
  'deviation.proposed',
  'execution.settled',
  'mutation.executed',
  'mutation.executing_started',
  'onboard.executed',
  'onboard.requested',
  'orchestrate.intent_executed',
  'state.patched',
  'workflow.cancel',
  'workflow.checkpoint',
  'workflow.cleanup',
  'workflow.compensation',
  'workflow.fix-cycle',
  'workflow.prepared',
  'workflow.rehydrated',
  'workflow.started',
  'workflow.transition',
  'worktree.merge_executed',
  'worktree.merge_requested',
  'worktree.orphan_detected',
  'worktree.released',
  'worktree.reserved',
]);

export interface EmitterClosureResult {
  /** Every measured append is claimed, and every claim is live. */
  readonly ok: boolean;
  /** Distinct measured append sites considered — the DENOMINATOR. */
  readonly measuredSiteCount: number;
  /** Sites explained by an action's `autoEmits`. */
  readonly explainedByAction: number;
  /** Sites explained by a {@link MODULE_EMISSIONS} row. */
  readonly explainedByModule: number;
  /** Distinct events the action edges declare — the action arm's DENOMINATOR. */
  readonly declaredActionEventCount: number;
  readonly undeclared: readonly UndeclaredAppendSite[];
  readonly phantoms: readonly PhantomModuleEmission[];
  readonly unverifiable: readonly UnverifiableModuleEmission[];
  readonly phantomActionEmissions: readonly PhantomActionEmission[];
  readonly staleAllowance: readonly StaleUnresolvedAllowance[];
  readonly unverifiableActionEmissions: readonly UnverifiableActionEmission[];
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
 * Reconciles the measured append sites against both declaration surfaces. The function
 * returns a verdict and does not throw.
 *
 * An action edge explains EVERY site for its event, because `autoEmits` names an action
 * and not a file. The provider-area audit catches an append from an unexpected module.
 *
 * An action emission is confirmed when some module appends the event. It is unverifiable
 * when {@link UNRESOLVED_ACTION_EVENT_ALLOWANCE} covers it, and phantom otherwise. A module
 * row is unverifiable when the census did not scan its module.
 */
export function auditEmitterClosure(
  census: AppendSiteCensus,
  actionEdges: readonly EmissionEdge[],
  moduleEmissions: readonly ModuleEmission[] = MODULE_EMISSIONS,
  unresolvedAllowance: readonly string[] = UNRESOLVED_ACTION_EVENT_ALLOWANCE,
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

  const allowance = new Set(unresolvedAllowance);
  const declaredBy = new Map<string, Set<string>>();
  for (const edge of actionEdges) {
    const owners = declaredBy.get(edge.event) ?? new Set<string>();
    owners.add(`${edge.declaringTool}.${edge.action}`);
    declaredBy.set(edge.event, owners);
  }

  const phantomActionEmissions: PhantomActionEmission[] = [];
  const unverifiableActionEmissions: UnverifiableActionEmission[] = [];
  for (const [event, owners] of declaredBy) {
    if (census.modulesByEvent.has(event)) continue;
    if (allowance.has(event)) {
      unverifiableActionEmissions.push({ event, reason: 'append-not-resolvable' });
      continue;
    }
    phantomActionEmissions.push({
      code: 'PHANTOM_ACTION_EMISSION',
      event,
      declaredBy: Object.freeze([...owners].sort()),
      message:
        `${[...owners].sort().join(', ')} declare(s) the emission of '${event}', and the census ` +
        'finds no module that appends it. The append moved, was deleted, or its type stopped ' +
        'resolving. Delete the declaration or follow the append — and only if the append is real ' +
        'but rides a runtime-valued discriminant does the event belong on the unresolved-append ' +
        'allowance. A declared emission with no append reads as coverage while covering nothing.',
    });
  }

  const staleAllowance: StaleUnresolvedAllowance[] = [];
  for (const event of allowance) {
    if (census.modulesByEvent.has(event)) {
      staleAllowance.push({
        code: 'STALE_UNRESOLVED_ALLOWANCE',
        event,
        reason: 'append-now-resolved',
        message:
          `the unresolved-append allowance covers '${event}', and the census now resolves an ` +
          'append for it. The event no longer needs cover, and cover it does not need is cover ' +
          'that would silently absorb the next real phantom. Remove the row.',
      });
      continue;
    }
    if (!declaredBy.has(event)) {
      staleAllowance.push({
        code: 'STALE_UNRESOLVED_ALLOWANCE',
        event,
        reason: 'no-declaring-edge',
        message:
          `the unresolved-append allowance covers '${event}', and no action edge declares that ` +
          'event. The allowance exists to keep a DECLARED emission from being misread as stale; ' +
          'a row covering no declaration protects nothing. Remove the row.',
      });
    }
  }

  const byEvent = (
    a: { event: string; module: string },
    b: { event: string; module: string },
  ): number => a.event.localeCompare(b.event) || a.module.localeCompare(b.module);
  const byEventOnly = (a: { event: string }, b: { event: string }): number =>
    a.event.localeCompare(b.event);

  return Object.freeze({
    ok:
      undeclared.length === 0 &&
      phantoms.length === 0 &&
      phantomActionEmissions.length === 0 &&
      staleAllowance.length === 0,
    measuredSiteCount,
    explainedByAction,
    explainedByModule,
    declaredActionEventCount: declaredBy.size,
    undeclared: Object.freeze([...undeclared].sort(byEvent)),
    phantoms: Object.freeze([...phantoms].sort(byEvent)),
    unverifiable: Object.freeze([...unverifiable].sort(byEvent)),
    phantomActionEmissions: Object.freeze([...phantomActionEmissions].sort(byEventOnly)),
    staleAllowance: Object.freeze([...staleAllowance].sort(byEventOnly)),
    unverifiableActionEmissions: Object.freeze(
      [...unverifiableActionEmissions].sort(byEventOnly),
    ),
  });
}

/** An append an action answers for: the module that performs it, and the event. */
export interface ActionAppendOwnership {
  /** The registered action accountable for the append. */
  readonly action: string;
  /** The composite tool the accountable action is registered under. */
  readonly declaringTool: string;
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
  /** The composite tool the abstaining action is registered under. */
  readonly declaringTool: string;
  readonly because: string;
}

/** An owned append that no registry edge from the owning action backs. */
export interface UnbackedOwnedAppend {
  readonly code: 'UNDECLARED_ACTION_OWNED_APPEND';
  readonly action: string;
  readonly declaringTool: string;
  readonly event: string;
  readonly module: string;
  readonly message: string;
}

/** An owning action that reasons it emits nothing while the tree says otherwise. */
export interface FalseReasonedAbstention {
  readonly code: 'FALSE_REASONED_ABSTENTION';
  readonly action: string;
  readonly declaringTool: string;
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
  readonly declaringTool: string;
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
 * Every registered action whose contract reasons that it emits nothing. An action whose
 * contract does not normalize adds nothing, because an unreadable contract is not an abstention.
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
          abstentions.push({
            action: action.name,
            declaringTool: tool.name,
            because: contract.emissions.because,
          });
        }
      } catch {
        continue;
      }
    }
  }
  return Object.freeze(
    abstentions.sort(
      (a, b) =>
        a.declaringTool.localeCompare(b.declaringTool) || a.action.localeCompare(b.action),
    ),
  );
}

/**
 * The appends that the actions in this tree answer for. Each row states the wiring, so
 * a reader can check the claim in two files.
 *
 * The link from an action to its handler module exists only inside router closures, so
 * this list declares it. A one-hop import walk invents ownership. Rows are event-scoped,
 * so an action does not get every append in its module.
 */
export const ACTION_APPEND_OWNERSHIP: readonly ActionAppendOwnership[] = Object.freeze([
  {
    action: 'create_pr',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/vcs/create-pr.ts',
    event: 'pr.create.requested',
    wiring: 'the create-PR handler journals intent before the provider call',
  },
  {
    action: 'create_pr',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/vcs/create-pr.ts',
    event: 'pr.create.executed',
    wiring: 'the create-PR handler journals the result after the provider call',
  },
  {
    action: 'create_issue',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/vcs/create-issue.ts',
    event: 'issue.create.requested',
    wiring: 'the create-issue handler journals intent before the provider call',
  },
  {
    action: 'create_issue',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/vcs/create-issue.ts',
    event: 'issue.create.executed',
    wiring: 'the create-issue handler journals the result after the provider call',
  },
  {
    action: 'add_pr_comment',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/vcs/add-pr-comment.ts',
    event: 'pr.comment.executed',
    wiring: 'the comment handler journals the result on each of its three terminal paths',
  },
  {
    action: 'merge_orchestrate',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/merge/execute-merge.ts',
    event: 'merge.executing_started',
    wiring: 'the orchestrator delegates to the executor, which marks the executing phase',
  },
  {
    action: 'merge_orchestrate',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/merge/execute-merge.ts',
    event: 'merge.retry_attempt',
    wiring: 'the executor retry hook records each timeout retry',
  },
  {
    action: 'assess_stack',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/vcs/assess-stack.ts',
    event: 'provider.parse-error',
    wiring: 'the stack assessor records a review adapter that threw while parsing',
  },
  {
    action: 'assess_stack',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/vcs/assess-stack.ts',
    event: 'provider.unknown-tier',
    wiring: 'the stack assessor records a parsed item whose tier the adapter does not know',
  },
  {
    action: 'prune_stale_workflows',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/team/prune-stale-workflows.ts',
    event: 'prune.diagnostics',
    wiring: 'the prune evaluation writes its own audit line, fire-and-forget',
  },
  {
    action: 'cancel',
    declaringTool: 'exarchos_workflow',
    module: 'workflow/compensation.ts',
    event: 'branch.delete.requested',
    wiring: 'cancel is the sole caller of the compensation saga, whose branch compensator journals intent',
  },
  {
    action: 'cancel',
    declaringTool: 'exarchos_workflow',
    module: 'workflow/compensation.ts',
    event: 'branch.delete.executed',
    wiring: 'cancel is the sole caller of the compensation saga, whose branch compensator journals the result',
  },
  {
    action: 'prepare_review',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/team/prepare-review.ts',
    event: 'workflow.plan-review-dispatched',
    wiring: 'the plan scope counts each dispatch at the provisioning seam',
  },
  {
    action: 'classify_review_items',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/review/classify-review-items.ts',
    event: 'dispatch.classified',
    wiring: 'the classifier records the grouping, best-effort',
  },
  {
    action: 'prepare_delegation',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/team/dispatch-guard.ts',
    event: 'stash.detected',
    wiring: 'the delegation handler calls the stash probe',
  },
  {
    action: 'prepare_delegation',
    declaringTool: 'exarchos_orchestrate',
    module: 'verbs/team/prepare-delegation.ts',
    event: 'task.assigned',
    wiring:
      'the delegation handler announces each planned task the stream has not yet heard of, ' +
      'ahead of the readiness fold that counts them',
  },
]);

/**
 * Reconciles the owned appends against the tree, the registry, and the abstentions of
 * the actions. The function returns a verdict and does not throw.
 *
 * The closure audit keys edges by event name, so it cannot name the action that owes an
 * undeclared append. This audit names it.
 * - `stale`: the census does not confirm the row.
 * - `unbacked`: the action owns an append, declares no edge for it, and has no reasoned `none`.
 * - `falseAbstentions`: the action declares a reasoned `none` for an append that it owns.
 *
 * Keys are `declaringTool.action`, because two tools can register the same action name.
 */
export function auditActionOwnedAppends(
  census: AppendSiteCensus,
  actionEdges: readonly EmissionEdge[],
  abstentions: readonly ActionAbstention[] = reasonedAbstentions(),
  ownership: readonly ActionAppendOwnership[] = ACTION_APPEND_OWNERSHIP,
): ActionOwnedAppendAudit {
  const qualify = (declaringTool: string, action: string): string => `${declaringTool}.${action}`;
  const declaredByAction = new Set(
    actionEdges.map((edge) => `${qualify(edge.declaringTool, edge.action)} ${edge.event}`),
  );
  const abstentionBy = new Map(
    abstentions.map((row) => [qualify(row.declaringTool, row.action), row.because]),
  );

  const unbacked: UnbackedOwnedAppend[] = [];
  const falseAbstentions: FalseReasonedAbstention[] = [];
  const stale: StaleAppendOwnership[] = [];
  let confirmed = 0;

  for (const row of ownership) {
    const qualified = qualify(row.declaringTool, row.action);
    if (!census.scannedModules.includes(row.module)) {
      stale.push({
        code: 'STALE_APPEND_OWNERSHIP',
        action: row.action,
        declaringTool: row.declaringTool,
        event: row.event,
        module: row.module,
        reason: 'module-not-scanned',
        message:
          `'${qualified}' is declared to answer for '${row.event}' in '${row.module}', and the ` +
          'census never read that module. The path is wrong, or the module left the scanned tree; ' +
          'either way the claim rests on a file nothing measured.',
      });
      continue;
    }
    if (census.modulesByEvent.get(row.event)?.includes(row.module) !== true) {
      stale.push({
        code: 'STALE_APPEND_OWNERSHIP',
        action: row.action,
        declaringTool: row.declaringTool,
        event: row.event,
        module: row.module,
        reason: 'append-not-in-module',
        message:
          `'${qualified}' is declared to answer for '${row.event}' in '${row.module}', and the ` +
          'census finds no such append there. Follow the append or delete the row: an ownership ' +
          'claim over an append that is gone attributes nothing while looking like attribution.',
      });
      continue;
    }

    confirmed += 1;
    if (declaredByAction.has(`${qualified} ${row.event}`)) continue;

    const because = abstentionBy.get(qualified);
    if (because !== undefined) {
      falseAbstentions.push({
        code: 'FALSE_REASONED_ABSTENTION',
        action: row.action,
        declaringTool: row.declaringTool,
        event: row.event,
        module: row.module,
        because,
        message:
          `'${qualified}' declares that it emits nothing — "${because}" — while '${row.module}', ` +
          `which it reaches, appends '${row.event}'. A reasoned abstention is a statement about ` +
          'the tree, and this one is false. It is worse than a missing edge: an omission reads as ' +
          'unfinished, a wrong reason reads as settled.',
      });
      continue;
    }
    unbacked.push({
      code: 'UNDECLARED_ACTION_OWNED_APPEND',
      action: row.action,
      declaringTool: row.declaringTool,
      event: row.event,
      module: row.module,
      message:
        `'${qualified}' answers for the append of '${row.event}' in '${row.module}' and declares ` +
        'no edge for it. The event is this action\'s effect, so the action is where it belongs — ' +
        'an append attributed to nobody is one no downstream check can hold anyone to.',
    });
  }

  const byRow = (
    a: { action: string; declaringTool: string; event: string },
    b: { action: string; declaringTool: string; event: string },
  ): number =>
    a.declaringTool.localeCompare(b.declaringTool) ||
    a.action.localeCompare(b.action) ||
    a.event.localeCompare(b.event);

  return Object.freeze({
    ok: unbacked.length === 0 && falseAbstentions.length === 0 && stale.length === 0,
    confirmedOwnedAppends: confirmed,
    abstainingActions: abstentions.length,
    unbacked: Object.freeze([...unbacked].sort(byRow)),
    falseAbstentions: Object.freeze([...falseAbstentions].sort(byRow)),
    stale: Object.freeze([...stale].sort(byRow)),
  });
}
