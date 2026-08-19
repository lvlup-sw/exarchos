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
