import { type ExemptedFinding, GUARD_EXEMPTIONS, type GuardExemption } from './exemptions.js';
import { manifestPrimaries } from './manifest.js';
import type { GuardInventory } from './model.js';
import { globMatches } from './vitest-projects.js';

export interface InventoryAudit {
  readonly ok: boolean;
  readonly violations: readonly string[];
  /** Path-filtered-only guards, surfaced so the hosting is reported, not accepted. */
  readonly pathFilteredOnly: readonly string[];
  /** Guards that no production module imports. */
  readonly noProductionCaller: readonly string[];
}

/**
 * Proves that every guard is reachable from CI. Each violation line holds a code in brackets.
 * A scan that finds zero guards, zero `run:` steps, zero wrapper scripts or zero entrypoint
 * sources fails, because a clean result then proves nothing.
 *
 * An unreachable guard fails without an exemption. A guard that runs only when `argv[1]`
 * ends with its own filename fails, because a rename makes it a no-op. A guard hosted only in
 * path-filtered jobs fails when its source is outside every filter and no unfiltered
 * pull-request host re-asserts it. An exemption fails when it is orphaned, stale or expired.
 * The audit checks a `filtered-implementation-surface` exemption only when `filterGlobs` is given.
 */
export function auditGuardInventory(
  inventory: GuardInventory,
  options: {
    readonly now?: Date;
    readonly exemptions?: readonly GuardExemption[];
    readonly manifestJson?: unknown;
    readonly filterGlobs?: Record<string, string[]>;
  } = {},
): InventoryAudit {
  const now = options.now ?? new Date();
  const exemptions = options.exemptions ?? GUARD_EXEMPTIONS;
  const violations: string[] = [];
  const byArtifact = new Map(inventory.guards.map((g) => [g.artifact, g]));

  if (inventory.guards.length === 0) {
    violations.push(
      '[empty-inventory]  the inventory resolved zero guards — a run that finds nothing ' +
        'fails rather than passing clean (DR-24 non-empty denominator)',
    );
  }

  if (inventory.indirection.runStepsWalked === 0) {
    violations.push(
      '[empty-indirection-walk]  the wrapper-script resolver walked ZERO `run:` steps — ' +
        'indirect hosting cannot have been resolved, so a clean result proves nothing',
    );
  } else if (inventory.indirection.wrapperScriptsWalked.length === 0) {
    violations.push(
      `[empty-indirection-walk]  the resolver walked ${inventory.indirection.runStepsWalked} ` +
        '`run:` step(s) but read ZERO wrapper scripts — either no CI step invokes a shell ' +
        'script (it does) or the walk is broken; a guard hosted only through a wrapper would ' +
        'read as unwired',
    );
  }

  const excusedBy = (artifact: string, finding: ExemptedFinding): GuardExemption | undefined =>
    exemptions.find((e) => e.artifact === artifact && e.excuses === finding);

  for (const guard of inventory.guards) {
    if (guard.enforcement !== 'unreachable') continue;
    if (excusedBy(guard.artifact, 'unreachable') === undefined) {
      violations.push(
        `${guard.artifact}  [unwired-guard]  no CI job executes it and no expiring reason is ` +
          'recorded — wire it, or add a GUARD_EXEMPTIONS entry with an owner and an expiry',
      );
    }
  }

  const filterGlobs = options.filterGlobs ?? {};
  const filtersKnown = Object.keys(filterGlobs).length > 0;
  const pathFilteredOnly: string[] = [];
  const exhibits = new Map<ExemptedFinding, Set<string>>([
    ['unreachable', new Set(inventory.guards.filter((g) => g.enforcement === 'unreachable').map((g) => g.artifact))],
    ['filtered-implementation-surface', new Set<string>()],
    ['filename-coupled-entrypoint', new Set(inventory.filenameCoupledEntrypoints.map((e) => e.artifact))],
  ]);

  if (inventory.entrypointPredicatesScanned === 0) {
    violations.push(
      '[empty-entrypoint-scan]  the entrypoint-predicate classifier parsed ZERO guard ' +
        'sources — no coupling could have been found, so a clean result proves nothing',
    );
  }
  for (const coupled of inventory.filenameCoupledEntrypoints) {
    if (excusedBy(coupled.artifact, 'filename-coupled-entrypoint') !== undefined) continue;
    violations.push(
      `${coupled.artifact}  [filename-coupled-entrypoint]  self-executes on ` +
        `${coupled.literals.map((l) => `\`argv[1].endsWith('${l}')\``).join(' or ')}, so renaming ` +
        'it leaves a step that runs and enforces nothing while this inventory still reports it ' +
        'as hosted — compare the RESOLVED `argv[1]` against `fileURLToPath(import.meta.url)`, ' +
        'or record an expiring GUARD_EXEMPTIONS entry',
    );
  }

  for (const guard of inventory.guards) {
    if (!guard.pathFilteredOnly) continue;
    pathFilteredOnly.push(guard.artifact);
    if (!filtersKnown) continue;
    const keys = [...new Set(guard.hosts.flatMap((h) => [...h.pathFilterKeys]))];
    const anyUnfilteredHost = guard.hosts.some((h) => h.pathFilterKeys.length === 0 && h.onPullRequest);
    const covered =
      anyUnfilteredHost ||
      keys.some((key) => (filterGlobs[key] ?? []).some((glob) => globMatches(glob, guard.artifact)));
    if (keys.length === 0 || covered) continue;
    exhibits.get('filtered-implementation-surface')?.add(guard.artifact);
    if (excusedBy(guard.artifact, 'filtered-implementation-surface') !== undefined) continue;
    violations.push(
      `${guard.artifact}  [implementation-surface-outside-filter]  hosted only in job(s) ` +
        `filtered on ${keys.join(', ')}, but its own source is outside every one of those ` +
        'filters and no unfiltered job re-asserts it — a PR that weakens it skips the job ' +
        'that would notice (docs/guides/ci-gate-hosting.md, two-surface subset rule)',
    );
  }

  for (const exemption of exemptions) {
    if (!byArtifact.has(exemption.artifact)) {
      violations.push(
        `${exemption.artifact}  [orphan-exemption]  exempted but absent from the inventory — ` +
          'the guard moved, was renamed, or was deleted',
      );
      continue;
    }
    const checkable =
      exemption.excuses === 'unreachable' ||
      exemption.excuses === 'filename-coupled-entrypoint' ||
      filtersKnown;
    if (checkable && exhibits.get(exemption.excuses)?.has(exemption.artifact) !== true) {
      violations.push(
        `${exemption.artifact}  [stale-exemption]  no longer exhibits "${exemption.excuses}" — ` +
          'remove the exemption so a later regression cannot pass unnoticed',
      );
    }
    const expiry = Date.parse(`${exemption.expires}T00:00:00Z`);
    if (Number.isNaN(expiry)) {
      violations.push(`${exemption.artifact}  [expired-exemption]  unparseable expiry "${exemption.expires}"`);
    } else if (expiry <= now.getTime()) {
      violations.push(
        `${exemption.artifact}  [expired-exemption]  expired ${exemption.expires} ` +
          `(blocked on ${exemption.blockedBy}) — fix it or re-justify with a new deadline`,
      );
    }
  }

  if (options.manifestJson !== undefined) {
    for (const primary of manifestPrimaries(options.manifestJson)) {
      if (!byArtifact.has(primary)) {
        violations.push(
          `${primary}  [manifest-primary-missing]  dispositioned in the enforcer manifest but ` +
            "absent from this inventory — the inventory denominator has fallen below the manifest's",
        );
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    pathFilteredOnly: pathFilteredOnly.sort(),
    noProductionCaller: inventory.guards
      .filter((g) => g.productionImported === false)
      .map((g) => g.artifact)
      .sort(),
  };
}
