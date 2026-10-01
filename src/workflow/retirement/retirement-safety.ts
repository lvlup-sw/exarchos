// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31) — the mechanical
// disposition proof that gates the retirement of the legacy admission authorities.
// Only tests call it. It retires with the legacy path that it audits, behind the
// same cutover issue as `workflow/admission/cutover-gate.ts`.
//
// A legacy authority must not go before evidence shows that its replacement is sound.
// For each authority, the scan folds the production importers of its modules, its
// live-behavior tests and the cutover-gate status into one disposition. The importer
// scan mirrors the `tools/audit/refgraph.mjs` detector.
//
// The core is pure. It takes source modules, authority descriptors and a cutover-gate
// status, and it imports nothing from the admission layer. The co-located test gathers
// the real source tree and the real gate evidence.

/**
 * The classes of legacy authority to retire.
 * - `legacy-guard`: the legacy HSM transition-guard registry.
 * - `hsm-registry`: the legacy HSM definition registry and its executor.
 * - `playbook-registry`: the legacy phase-playbook registry.
 * - `obsolete-predicate`: a dead guard predicate that the guard-classification corpus marks obsolete.
 * - `pass-state-fix`: a direct pass-state mutation fix.
 * - `manual-inventory`: a hand-maintained inventory that a governed registry replaces.
 */
export type AuthorityKind =
  | 'legacy-guard'
  | 'hsm-registry'
  | 'playbook-registry'
  | 'obsolete-predicate'
  | 'pass-state-fix'
  | 'manual-inventory';

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
   * The src-relative POSIX module paths that go with this authority.
   * An importer in this list is an internal edge, so it never blocks the deletion.
   */
  readonly modules: readonly string[];
  /**
   * True when the deletion of this authority moves production enforcement off the legacy path.
   * Then only a satisfied cutover gate lets it retire.
   */
  readonly cutoverGated: boolean;
  /**
   * Co-located tests that pin the live behavior of this authority, for example the guard-classification characterization.
   * A non-empty list blocks the deletion by itself.
   */
  readonly liveBehaviorTests?: readonly string[];
}

export type Disposition =
  | 'safe-to-delete'
  | 'blocked-by-cutover-gate'
  | 'blocked-by-live-reference';

/**
 * The cutover-gate fields that the scan reads. The type is structural, so this module does not import `workflow/admission`.
 * The test adapts the real `CutoverGateReport` to it.
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
  /** Live-behavior tests that the deletion breaks (sorted). */
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

/** A fully-materialized source module (the test supplies content + test-ness). */
export interface SourceModule {
  /** The src-relative POSIX path, for example `workflow/guards.ts`. */
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

/**
 * A copy of the IMP pattern of `refgraph.mjs`. It matches a `from`, `import`, `import()` or `require()` specifier.
 * The lazy class before `from` includes a newline, so the pattern also matches a multi-line import.
 */
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
 * Resolves a relative specifier to an extension-stripped target key.
 * It uses POSIX string arithmetic and not `node:path`, so the ownership census finds no effect.
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
 * Maps each target module to its production importers. A test module does not count.
 * A type-only import counts, as in refgraph and the module-intent gate.
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
    if (mod.isTest) continue;
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

/** Returns the production importers of the modules of an authority, without the importers inside the authority. */
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

/**
 * Folds the importer evidence and the cutover-gate status into one disposition.
 * The gate comes first. A gated authority stays blocked until the gate is satisfied, even with zero references.
 * Next, a production reference or a live-behavior test blocks it. With neither blocker, the result is `safe-to-delete`.
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

/** The legacy authorities that wait for retirement. */
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

/** A source pattern whose reappearance in production code reinstates a retired authority. */
export interface ForbiddenSourcePattern {
  /** Stable id, unique within its authority. */
  readonly id: string;
  /** RegExp source (applied per-module with the `g` flag). */
  readonly pattern: string;
  /** What reappearing means, phrased as the violation message. */
  readonly description: string;
}

/** An authority of a declared kind that is already retired. */
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

/**
 * The retired authorities. Each entry lists the source patterns that reinstate it.
 * A test runs `scanRetiredAuthorityReintroduction` over the production tree, so a reintroduction fails mechanically.
 */
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
 * Marks each position on a line that is inside a string literal. A string that names a retired pattern does not reinstate it.
 * The mask covers one line, so an unterminated literal affects only the rest of its line.
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
 * Scans production source for the reintroduction of a retired authority, and returns every hit in sorted order.
 * The scan skips test modules, so a test can describe the retired behavior. It also skips a line that is only a comment.
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
          const code = line.trim();
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
          const mask = stringLiteralMask(code);
          const re = new RegExp(forbidden.pattern, 'g');
          let hit = false;
          for (const match of code.matchAll(re)) {
            if (match.index === undefined) continue;
            if (mask[match.index] === true) continue;
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
