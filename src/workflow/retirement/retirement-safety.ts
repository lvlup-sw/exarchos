// ─── P07-05 / Transition task 037 — Retirement-safety scan ────────────────────
//
// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31) — the mechanical
// disposition proof that gates the eventual retirement of the legacy admission
// authorities. Test-invoked gate machinery: it has no production importer by
// design (the shipped server never depends on a deletion-planning analysis). It
// retires together with the legacy path it audits, behind the same cutover
// issue (#1590) as `workflow/admission/cutover-gate.ts`.
//
// ── Why this module exists ────────────────────────────────────────────────────
//
// P07-05 is the FINAL package of the structural-closure-remediation program:
// "remove legacy and manual authorities … after replacements gate CI." The
// program stages the cutover deliberately — P07-01 shadow → P07-02 migrate →
// P07-05 delete — precisely so a legacy authority is never deleted before the
// evidence that its replacement is sound exists. Deleting the legacy HSM guard
// while the event-sourced cutover gate is still unsatisfied would flip
// enforcement without that evidence: the exact premature cutover the program was
// built to prevent.
//
// The work package's exit proof is therefore the GATING DISCIPLINE itself:
// "Reachability and dependency scans prove no production references remain
// before deletion." This module is that proof, made mechanical and total. For
// every legacy authority it folds two independent, pre-existing scans plus the
// cutover gate into ONE typed, evidence-backed disposition:
//
//   • REACHABILITY (P05-05 `contract/reachability`) — the public action surface
//     is fully closed (120/120) independent of the legacy guard, and the P07-02
//     structure test proves the shared IR reaches NO legacy guard module. So no
//     PUBLIC ACTION depends on the legacy guard.
//   • DEPENDENCY (the vendored `scripts/audit/refgraph.mjs` detector, mirrored
//     purely here) — which production (non-test) modules still IMPORT each
//     authority's modules. A single external importer is a live reference.
//   • CUTOVER GATE (P07-01 `cutover-gate.ts`) — whether enforcement may flip off
//     the legacy path at all yet.
//
// ── The three dispositions ────────────────────────────────────────────────────
//
//   safe-to-delete            — reachability + dependency scans prove ZERO
//                               external production references AND (for a
//                               cutover-gated authority) the gate is satisfied.
//   blocked-by-cutover-gate   — the authority's deletion would flip enforcement
//                               and the event-sourced cutover gate is not yet
//                               satisfied; the report names the unmet conditions.
//   blocked-by-live-reference — a production module (or a live-behaviour test)
//                               still binds the authority; deleting it now breaks
//                               live code/tests.
//
// The core is PURE and effect-free: it takes fully-materialized source modules,
// authority descriptors, and a cutover-gate STATUS (structurally, so this module
// imports nothing from the admission layer). The real source tree + real gate
// evidence are gathered by the co-located test — the same "pure core, injected
// evidence" shape the cutover gate itself uses.

// ─── Legacy-authority model ────────────────────────────────────────────────────

/**
 * The classes of legacy authority P07-05 is chartered to retire. Each names a
 * concrete category from the work package ("legacy guards, direct pass-state
 * fixes, closed playbook/HSM registries, and manual inventories").
 */
export type AuthorityKind =
  | 'legacy-guard' // the legacy HSM transition-guard registry
  | 'hsm-registry' // the legacy HSM definition registry + executor
  | 'playbook-registry' // the legacy phase-playbook registry
  | 'obsolete-predicate' // a dead guard predicate the P06-01 corpus classified obsolete
  | 'pass-state-fix' // a direct pass-state mutation fix
  | 'manual-inventory'; // a hand-maintained inventory a governed registry superseded

export const AUTHORITY_KINDS: readonly AuthorityKind[] = Object.freeze([
  'legacy-guard',
  'hsm-registry',
  'playbook-registry',
  'obsolete-predicate',
  'pass-state-fix',
  'manual-inventory',
]);

/** A legacy authority whose retirement this scan adjudicates. */
export interface LegacyAuthority {
  /** Stable id, unique across the registry. */
  readonly id: string;
  readonly kind: AuthorityKind;
  /** One-line description of what deleting this authority entails. */
  readonly summary: string;
  /**
   * The src-root-relative, POSIX module paths (`.ts`) whose deletion this
   * authority entails. An importer that is itself one of these modules is an
   * INTERNAL edge (the whole cluster is deleted together) and never counts as a
   * blocking live reference.
   */
  readonly modules: readonly string[];
  /**
   * True when deleting this authority would flip production enforcement off the
   * legacy path. Such an authority can only be retired behind a SATISFIED
   * event-sourced cutover gate — it is the program's staging point.
   */
  readonly cutoverGated: boolean;
  /**
   * Co-located tests that pin this authority's LIVE behaviour (e.g. the P06-01
   * guard-classification characterization the cutover corpus depends on).
   * Deleting the authority would gut these — which the DoD forbids while they
   * still cover live behaviour. A non-empty list is an independent blocker.
   */
  readonly liveBehaviorTests?: readonly string[];
}

// ─── Disposition model ─────────────────────────────────────────────────────────

export type Disposition =
  | 'safe-to-delete'
  | 'blocked-by-cutover-gate'
  | 'blocked-by-live-reference';

/**
 * The minimal cutover-gate view this scan needs, taken structurally so the
 * module has no import edge into `workflow/admission`. The test adapts the real
 * `CutoverGateReport` (from `workflow/admission/cutover-gate.ts`) onto it.
 */
export interface CutoverGateStatus {
  readonly satisfied: boolean;
  readonly unmetConditions: readonly string[];
}

/** The evidence-backed verdict for one authority. */
export interface AuthorityDisposition {
  readonly authorityId: string;
  readonly kind: AuthorityKind;
  readonly disposition: Disposition;
  /** External production importers that still bind the authority (sorted). */
  readonly productionReferences: readonly string[];
  /** Live-behaviour tests deletion would gut (sorted). */
  readonly liveBehaviorTests: readonly string[];
  /** Unmet cutover-gate conditions (only when blocked-by-cutover-gate). */
  readonly unmetGateConditions: readonly string[];
  readonly rationale: string;
}

export interface RetirementScanReport {
  readonly gateSatisfied: boolean;
  readonly dispositions: readonly AuthorityDisposition[];
  /** Authority ids the scan PROVED safe to delete now (empty is a valid, honest result). */
  readonly safeToDelete: readonly string[];
  /** Authority ids still blocked, with their blocking reason on each disposition. */
  readonly blocked: readonly string[];
}

// ─── Dependency scan (pure mirror of the vendored refgraph detector) ───────────

/** A fully-materialized source module (the test supplies content + test-ness). */
export interface SourceModule {
  /** src-root-relative, POSIX path, e.g. `workflow/guards.ts`. */
  readonly path: string;
  readonly content: string;
  /** True for `*.test.ts` / fixture / bench modules — NOT a production importer. */
  readonly isTest: boolean;
}

const MODULE_EXTENSION_RE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/;

/** Strip a module extension so `.js` specifiers match their `.ts` source. */
export function stripModuleExtension(path: string): string {
  return path.replace(MODULE_EXTENSION_RE, '');
}

// Mirrors refgraph.mjs's IMP pattern: `from '…'`, `import '…'`, `import('…')`,
// `require('…')`. `[^'"]*?` spans newlines (a `[^'"]` class includes `\n`), so a
// multi-line `import { … } from '…'` is matched.
const IMPORT_SPECIFIER_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every RELATIVE import specifier a module declares (bare specifiers dropped). */
export function extractRelativeImports(content: string): readonly string[] {
  const specs: string[] = [];
  for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined && spec.startsWith('.')) specs.push(spec);
  }
  return specs;
}

function directoryOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/**
 * Resolve a relative specifier from a module to an extension-stripped target
 * key. Pure POSIX path arithmetic (no `node:path`, so the module performs no
 * effect the ownership census could flag).
 */
export function resolveRelativeTarget(fromPath: string, spec: string): string {
  const base = directoryOf(fromPath);
  const stack = base === '' ? [] : base.split('/');
  for (const segment of spec.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stripModuleExtension(stack.join('/'));
}

/**
 * Map each target module to the set of modules that import it. Only PRODUCTION
 * (non-test) importers are counted — a type-only importer still counts (an
 * `import type` edge is a real justification for the module's existence, exactly
 * as refgraph and the module-intent gate treat it).
 */
export function scanProductionReferences(
  modules: readonly SourceModule[],
  targets: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const keyToTarget = new Map<string, string>();
  for (const target of targets) keyToTarget.set(stripModuleExtension(target), target);

  const importers = new Map<string, Set<string>>();
  for (const target of targets) importers.set(target, new Set<string>());

  for (const mod of modules) {
    if (mod.isTest) continue; // production importers only
    for (const spec of extractRelativeImports(mod.content)) {
      const resolvedKey = resolveRelativeTarget(mod.path, spec);
      for (const candidate of [resolvedKey, `${resolvedKey}/index`]) {
        const target = keyToTarget.get(candidate);
        if (target === undefined) continue;
        const set = importers.get(target);
        if (set !== undefined) set.add(mod.path);
      }
    }
  }

  const out = new Map<string, readonly string[]>();
  for (const [target, set] of importers) out.set(target, [...set].sort());
  return out;
}

/**
 * The EXTERNAL production references to an authority: every non-test importer of
 * any of the authority's modules that is not itself part of the authority (an
 * internal edge inside a self-contained cluster is not a blocker).
 */
export function productionReferencesForAuthority(
  authority: LegacyAuthority,
  modules: readonly SourceModule[],
): readonly string[] {
  const own = new Set(authority.modules);
  const references = scanProductionReferences(modules, authority.modules);
  const external = new Set<string>();
  for (const [, importerPaths] of references) {
    for (const importer of importerPaths) {
      if (!own.has(importer)) external.add(importer);
    }
  }
  return [...external].sort();
}

// ─── Disposition (pure) ────────────────────────────────────────────────────────

/**
 * Fold the dependency evidence + cutover-gate status into ONE disposition.
 *
 * Precedence — the cutover gate dominates: an authority whose deletion flips
 * enforcement cannot be retired until the gate is satisfied, EVEN IF it happened
 * to have zero references, because the gate governs the enforcement flip itself.
 * Only once an authority is either not cutover-gated (or the gate is satisfied)
 * does a live reference become the deciding blocker; with neither blocker, the
 * scan reports `safe-to-delete` and cites the zero-reference proof.
 */
export function disposeAuthority(
  authority: LegacyAuthority,
  productionReferences: readonly string[],
  gate: CutoverGateStatus,
  liveBehaviorTests: readonly string[] = authority.liveBehaviorTests ?? [],
): AuthorityDisposition {
  const prodRefs = [...productionReferences].sort();
  const liveTests = [...liveBehaviorTests].sort();

  if (authority.cutoverGated && !gate.satisfied) {
    const unmet = gate.unmetConditions.join(', ') || 'none';
    return {
      authorityId: authority.id,
      kind: authority.kind,
      disposition: 'blocked-by-cutover-gate',
      productionReferences: prodRefs,
      liveBehaviorTests: liveTests,
      unmetGateConditions: [...gate.unmetConditions],
      rationale:
        `deleting '${authority.id}' would flip enforcement off the legacy path, but the ` +
        `event-sourced cutover gate is NOT satisfied (unmet: ${unmet}). Retirement is ` +
        `deferred until the gate is green.` +
        (prodRefs.length > 0
          ? ` ${prodRefs.length} live production reference(s) also remain.`
          : ''),
    };
  }

  if (prodRefs.length > 0 || liveTests.length > 0) {
    return {
      authorityId: authority.id,
      kind: authority.kind,
      disposition: 'blocked-by-live-reference',
      productionReferences: prodRefs,
      liveBehaviorTests: liveTests,
      unmetGateConditions: [],
      rationale:
        `'${authority.id}' still has ${prodRefs.length} production reference(s)` +
        (liveTests.length > 0 ? ` and ${liveTests.length} live-behaviour test(s)` : '') +
        `; deleting it now would break live code/tests.`,
    };
  }

  return {
    authorityId: authority.id,
    kind: authority.kind,
    disposition: 'safe-to-delete',
    productionReferences: [],
    liveBehaviorTests: [],
    unmetGateConditions: [],
    rationale:
      `reachability + dependency scans prove 0 production references to '${authority.id}'` +
      (authority.cutoverGated ? ' and the cutover gate is satisfied' : '') +
      '; safe to delete.',
  };
}

/** Run the disposition over every authority against the materialized tree + gate. */
export function runRetirementScan(
  authorities: readonly LegacyAuthority[],
  modules: readonly SourceModule[],
  gate: CutoverGateStatus,
): RetirementScanReport {
  const dispositions = authorities.map((authority) =>
    disposeAuthority(authority, productionReferencesForAuthority(authority, modules), gate),
  );
  const safeToDelete = dispositions
    .filter((d) => d.disposition === 'safe-to-delete')
    .map((d) => d.authorityId);
  const blocked = dispositions
    .filter((d) => d.disposition !== 'safe-to-delete')
    .map((d) => d.authorityId);
  return { gateSatisfied: gate.satisfied, dispositions, safeToDelete, blocked };
}

/** Render a human-readable disposition table (for the exit-proof report). */
export function formatDispositionTable(report: RetirementScanReport): string {
  const lines: string[] = [];
  lines.push(
    `Retirement-safety disposition (cutover gate ${report.gateSatisfied ? 'SATISFIED' : 'NOT satisfied'})`,
  );
  for (const d of report.dispositions) {
    lines.push(`  • ${d.authorityId} [${d.kind}] → ${d.disposition}`);
    if (d.unmetGateConditions.length > 0) {
      lines.push(`      unmet gate conditions: ${d.unmetGateConditions.join(', ')}`);
    }
    if (d.productionReferences.length > 0) {
      lines.push(
        `      production references (${d.productionReferences.length}): ${d.productionReferences.join(', ')}`,
      );
    }
    if (d.liveBehaviorTests.length > 0) {
      lines.push(`      live-behaviour tests: ${d.liveBehaviorTests.join(', ')}`);
    }
    lines.push(`      ${d.rationale}`);
  }
  lines.push(
    `  safe-to-delete: ${report.safeToDelete.length === 0 ? '(none)' : report.safeToDelete.join(', ')}`,
  );
  lines.push(`  blocked: ${report.blocked.length === 0 ? '(none)' : report.blocked.join(', ')}`);
  return lines.join('\n');
}

// ─── The legacy-authority registry ─────────────────────────────────────────────
//
// The concrete set P07-05 is chartered to retire. Module paths mirror the P07-02
// structure test's FORBIDDEN legacy-guard set, so this registry and the shared-IR
// independence proof name the same modules.

export const LEGACY_AUTHORITIES: readonly LegacyAuthority[] = Object.freeze([
  {
    id: 'legacy-hsm-guard',
    kind: 'legacy-guard',
    summary:
      'The authoritative legacy HSM transition-guard registry — guard predicates (guards.ts), ' +
      'composite guards (hsm-definitions.ts), the guard executor (hsm-transition-guard.ts) and ' +
      'the config guard bridge (config/guards.ts). Still the production decider until cutover.',
    modules: [
      'workflow/guards.ts',
      'workflow/hsm-definitions.ts',
      'workflow/hsm-transition-guard.ts',
      'config/guards.ts',
    ],
    liveBehaviorTests: ['workflow/guards.test.ts', 'workflow/hsm-transition-guard.test.ts'],
    cutoverGated: true,
  },
  {
    id: 'legacy-hsm-registry',
    kind: 'hsm-registry',
    summary:
      'The legacy HSM definition registry + executor (state-machine.ts: hsmRegistry, ' +
      'getHSMDefinition, executeTransition) and its config registration (config/register.ts).',
    modules: ['workflow/state-machine.ts', 'config/register.ts'],
    liveBehaviorTests: ['workflow/state-machine.test.ts'],
    cutoverGated: true,
  },
  {
    id: 'legacy-obsolete-predicates',
    kind: 'obsolete-predicate',
    summary:
      "Obsolete guard predicates the P06-01 corpus classified as dead ('always', " +
      "'design-artifact-exists', 'root-cause-found', 'brief-complete') — embedded in the " +
      'still-authoritative guards.ts and pinned by the guard-classification characterization. ' +
      'The corpus itself defers their removal to "when the legacy guard registry is retired".',
    modules: ['workflow/guards.ts'],
    liveBehaviorTests: ['workflow/guard-classification.test.ts'],
    cutoverGated: true,
  },
  {
    id: 'legacy-playbook-registry',
    kind: 'playbook-registry',
    summary:
      'The legacy phase-playbook registry (playbooks.ts). The work package targets "closed" ' +
      'playbook registries; the dependency scan decides whether it is in fact closed yet.',
    modules: ['workflow/playbooks.ts'],
    liveBehaviorTests: ['workflow/playbooks.test.ts'],
    cutoverGated: false,
  },
]);

// ─── Retired authorities (DR-8) ────────────────────────────────────────────────
//
// `LEGACY_AUTHORITIES` above is the set still AWAITING retirement. This second
// registry is its counterpart: authorities of a declared `AuthorityKind` that
// have ALREADY been retired. Keeping both in one module is what stops the
// registry from claiming a retired fix is still active (or the reverse) — the
// `pass-state-fix` kind was declared in `AuthorityKind` with no member on either
// side, so the classification named a class nothing was accountable for.
//
// A retirement is only real if it cannot be silently undone, so each retired
// authority carries the SOURCE PATTERNS whose reappearance in production code
// would reinstate it. The co-located structural test (and, for the cleanup
// pass-state fix, `workflow/cleanup.pass-state.test.ts`) runs
// `scanRetiredAuthorityReintroduction` over the real production tree, so a
// future reintroduction fails mechanically rather than by review vigilance.

/** A source pattern whose reappearance in production code reinstates a retired authority. */
export interface ForbiddenSourcePattern {
  /** Stable id, unique within its authority. */
  readonly id: string;
  /** RegExp source (applied per-module with the `g` flag). */
  readonly pattern: string;
  /** What reappearing means, phrased as the violation message. */
  readonly description: string;
}

/** An authority of a declared kind that has already been retired. */
export interface RetiredAuthority {
  readonly id: string;
  readonly kind: AuthorityKind;
  readonly summary: string;
  /** The design requirement whose implementation retired it. */
  readonly retiredBy: string;
  /**
   * src-root-relative POSIX prefixes the scan restricts itself to. Empty means
   * the whole production tree.
   */
  readonly scopes: readonly string[];
  readonly forbiddenPatterns: readonly ForbiddenSourcePattern[];
}

export const RETIRED_AUTHORITIES: readonly RetiredAuthority[] = Object.freeze([
  {
    id: 'cleanup-pass-state-fix',
    kind: 'pass-state-fix',
    summary:
      'The cleanup pass-state fix: `workflow/cleanup.ts` force-assigned every ' +
      "`reviews[*].status` (and nested sub-review status) to 'approved' and stamped " +
      '`_cleanup = { mergeVerified: true }` immediately before the guarded transition ' +
      'evaluated `guards.mergeVerified` — production code writing the guard\'s own inputs ' +
      'and then asking the guard for permission. Retired: cleanup now collects the evidence ' +
      '(reviews that were actually approved, a recorded merge artifact reference) and fails ' +
      'the guard when the evidence is absent.',
    retiredBy: 'DR-8',
    scopes: ['workflow/'],
    forbiddenPatterns: [
      {
        id: 'force-approve-review-status',
        pattern: String.raw`\.status\s*=\s*['"\x60]approved['"\x60]`,
        description:
          "production code assigns a review status to 'approved' — review approval is evidence, " +
          'not something a consumer of that evidence may write',
      },
      {
        id: 'force-write-merge-verified',
        pattern: String.raw`mergeVerified\s*[:=]\s*true`,
        description:
          'production code writes `mergeVerified: true` as a literal — the guard input must be ' +
          'derived from collected evidence, never hard-coded',
      },
      {
        id: 'force-write-cleanup-pass-state',
        pattern: String.raw`_cleanup\s*=\s*\{[^}]*mergeVerified\s*:\s*(?:true|1)\b`,
        description:
          'production code assigns the `_cleanup` pass-state block a hard-coded pass verdict ' +
          'before the guard reads it',
      },
    ],
  },
]);

/** One production-source occurrence of a forbidden pattern. */
export interface RetirementViolation {
  readonly authorityId: string;
  readonly patternId: string;
  /** src-root-relative POSIX module path. */
  readonly modulePath: string;
  /** 1-based line number of the occurrence. */
  readonly line: number;
  /** The offending source line, trimmed. */
  readonly snippet: string;
  readonly description: string;
}

/**
 * Per-character mask of which positions on a line sit INSIDE a string literal.
 *
 * Without this the scan flags its own error messages and this registry's own
 * descriptions — prose that NAMES the retired pattern is not a reinstatement of
 * it. Only code positions count. Evaluated per line (a state machine spanning
 * the file would be a parser, and this stays a detector), so an unterminated
 * literal only affects the remainder of its own line.
 */
function stringLiteralMask(line: string): readonly boolean[] {
  const mask: boolean[] = new Array<boolean>(line.length).fill(false);
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      mask[i] = true;
      if (ch === '\\') {
        if (i + 1 < line.length) mask[i + 1] = true;
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      mask[i] = true;
    }
  }
  return mask;
}

/**
 * Scan production source for the reintroduction of a retired authority.
 *
 * PRODUCTION ONLY — `isTest` modules are skipped, so a test may still *describe*
 * the retired behaviour (characterization fixtures need to) without tripping the
 * scan. Returns every occurrence, sorted, so a failure names all of them at once.
 */
export function scanRetiredAuthorityReintroduction(
  modules: readonly SourceModule[],
  retired: readonly RetiredAuthority[] = RETIRED_AUTHORITIES,
): readonly RetirementViolation[] {
  const violations: RetirementViolation[] = [];
  for (const authority of retired) {
    for (const mod of modules) {
      if (mod.isTest) continue;
      if (
        authority.scopes.length > 0 &&
        !authority.scopes.some((scope) => mod.path.startsWith(scope))
      ) {
        continue;
      }
      const lines = mod.content.split(/\r?\n/);
      for (const forbidden of authority.forbiddenPatterns) {
        for (const [index, line] of lines.entries()) {
          // A line that is entirely a comment documents the retirement; it does
          // not reinstate it.
          const code = line.trim();
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
          const mask = stringLiteralMask(code);
          const re = new RegExp(forbidden.pattern, 'g');
          let hit = false;
          for (const match of code.matchAll(re)) {
            if (match.index === undefined) continue;
            if (mask[match.index] === true) continue; // inside a string literal
            hit = true;
            break;
          }
          if (!hit) continue;
          violations.push({
            authorityId: authority.id,
            patternId: forbidden.id,
            modulePath: mod.path,
            line: index + 1,
            snippet: code,
            description: forbidden.description,
          });
        }
      }
    }
  }
  return violations.sort(
    (a, b) =>
      a.authorityId.localeCompare(b.authorityId) ||
      a.modulePath.localeCompare(b.modulePath) ||
      a.line - b.line,
  );
}
