import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskLiteralsAndComments } from '../../../../tools/conformance/src/delivery-safety.js';

/**
 * T-11 / DR-7 — single phase-mutation authority, asserted STRUCTURALLY.
 *
 * DR-7 ("exactly one action mutates a phase", INV-9) was closed behaviourally by
 * T-10/T-12: `cleanup` and `cancel` stopped calling `executeTransition` directly
 * and now route through the guarded primitive. Behaviour alone cannot keep it
 * closed — a future module can re-open the bypass by importing
 * `executeTransition` and calling it, and every existing behavioural test would
 * still pass, because those tests exercise the paths that *were* fixed, not the
 * paths that do not exist yet.
 *
 * This census is the ratchet. It is a string-aware static scan of the shipped
 * MCP source (the same shape as `architecture/vcs-ownership.ts` and
 * `verbs/gates/gate-ownership-census.ts`) that enumerates every reference to the
 * phase-mutation primitive and fails closed when one appears outside the
 * declared authority surface. It is deliberately a two-way ratchet:
 *
 *   - UNAUTHORIZED_PHASE_MUTATION — a reference in a module no rule claims (the
 *     bypass DR-7 closes, re-opened);
 *   - STALE_PHASE_MUTATION_OWNER  — a declared owner that no longer references
 *     the primitive (phantom cover), so the allowlist cannot rot into a rubber
 *     stamp if `hsm-transition-guard.ts` is renamed or stops calling through.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * The detector matches the bare identifier `executeTransition` in *real code*
 * only: {@link maskLiteralsAndComments} blanks comment and string/template spans
 * first (offset-preserving), so the many JSDoc mentions of the primitive across
 * `cleanup.ts`, `cancel.ts`, `guards.ts`, `schemas.ts` and friends are NOT
 * findings, and neither is the prose that names it inside a string literal
 * (`retirement/retirement-safety.ts`). Matching the identifier rather than a
 * call shape is what makes the check bypass-proof: a re-exported binding, an
 * aliased import (`executeTransition as et`), a dynamic
 * `(await import(…)).executeTransition` and a plain call all mention the
 * identifier in code and are all caught.
 *
 * Known limit, stated rather than hidden: a call written *inside* a template
 * interpolation (`` `${executeTransition(…)}` ``) is masked with the rest of the
 * template and would be missed. `executeTransition` returns a structured
 * `TransitionResult`, never a string, so that is not a plausible bypass shape;
 * the behavioural guarantee for such a path is `hsm-transition-guard.ts`'s own
 * tests, not this scan.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The phase-mutation primitive whose invocation authority DR-7 constrains. */
const PHASE_MUTATION_PRIMITIVE = 'executeTransition';

/**
 * The modules permitted to reference the primitive in shipped source.
 *
 *   - `workflow/state-machine.ts`        — the DEFINITION site. It declares and
 *                                          exports the primitive; excluding it
 *                                          would make the census vacuous.
 *   - `workflow/hsm-transition-guard.ts` — the SINGLE production authority
 *                                          (DR-7). Every phase mutation —
 *                                          ordinary transitions, `cancel`, and
 *                                          `cleanup` since T-10 — composes
 *                                          through this primitive, which is what
 *                                          makes all of them shadow-observed and
 *                                          atomically trailed.
 *
 * `workflow/cancel.ts` and `workflow/cleanup.ts` deliberately do NOT appear:
 * they used to call `executeTransition` directly (the DR-7 bypass) and now hold
 * only a comment naming the bypass they replaced. Re-adding a live reference in
 * either trips UNAUTHORIZED_PHASE_MUTATION.
 */
const PHASE_MUTATION_OWNERS: readonly string[] = Object.freeze([
  'workflow/hsm-transition-guard.ts',
  'workflow/state-machine.ts',
]);

/** Directories that are not shipped source (test/fixture/bench harnesses). */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '__tests__',
  '__fixtures__',
  '__mocks__',
  'test-helpers',
  'bench',
  'benchmarks',
  'evals',
]);

/** True for a shipped-source TypeScript module (not a test/decl/bench file). */
function isShippedSource(name: string): boolean {
  return (
    name.endsWith('.ts') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.d.ts') &&
    !name.endsWith('.bench.ts')
  );
}

/** A single live reference to the phase-mutation primitive in shipped source. */
interface PhaseMutationRef {
  /** Scan-root-relative, forward-slashed. */
  readonly module: string;
  /** 1-based line in the original source. */
  readonly line: number;
  /** The original source line, trimmed — makes a failure self-describing. */
  readonly snippet: string;
}

type PhaseMutationDiagnostic =
  | {
      readonly code: 'UNAUTHORIZED_PHASE_MUTATION';
      readonly module: string;
      readonly line: number;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_PHASE_MUTATION_OWNER';
      readonly module: string;
      readonly message: string;
    };

interface PhaseMutationOwnershipResult {
  readonly ok: boolean;
  readonly refCount: number;
  readonly diagnostics: readonly PhaseMutationDiagnostic[];
}

/**
 * Enumerate every real-code reference to the primitive in one module. Pure.
 * Comments and string/template spans are masked first, so only executable
 * mentions count.
 */
export function detectPhaseMutationRefs(module: string, source: string): PhaseMutationRef[] {
  const masked = maskLiteralsAndComments(source);
  const lines = source.split('\n');
  const maskedLines = masked.split('\n');
  const identifier = new RegExp(`\\b${PHASE_MUTATION_PRIMITIVE}\\b`);
  const refs: PhaseMutationRef[] = [];

  for (let i = 0; i < maskedLines.length; i += 1) {
    if (identifier.test(maskedLines[i] ?? '')) {
      refs.push({ module, line: i + 1, snippet: (lines[i] ?? '').trim() });
    }
  }
  return refs;
}

/**
 * Pure ownership verdict over an already-collected reference set. Two
 * independent, complementary checks — a reference no owner claims, and an owner
 * that claims no reference.
 */
export function runPhaseMutationOwnershipCensus(
  refs: readonly PhaseMutationRef[],
  owners: readonly string[] = PHASE_MUTATION_OWNERS,
): PhaseMutationOwnershipResult {
  const ownerSet = new Set(owners);
  const diagnostics: PhaseMutationDiagnostic[] = [];

  for (const ref of refs) {
    if (!ownerSet.has(ref.module)) {
      diagnostics.push({
        code: 'UNAUTHORIZED_PHASE_MUTATION',
        module: ref.module,
        line: ref.line,
        message:
          `Module "${ref.module}" references ${PHASE_MUTATION_PRIMITIVE} at line ${ref.line} ` +
          `(${ref.snippet}) outside the phase-mutation authority surface. DR-7 requires exactly ` +
          `one action to mutate a phase: route the transition through the guarded primitive in ` +
          `workflow/hsm-transition-guard.ts (hsmTransitionGuard.attempt) so the mutation is ` +
          `shadow-observed and leaves no partial event trail.`,
      });
    }
  }

  for (const owner of owners) {
    if (!refs.some((ref) => ref.module === owner)) {
      diagnostics.push({
        code: 'STALE_PHASE_MUTATION_OWNER',
        module: owner,
        message:
          `Phase-mutation owner rule for "${owner}" claims no live reference to ` +
          `${PHASE_MUTATION_PRIMITIVE} — stale cover. Remove it from the owner set or restore ` +
          `the reference; a phantom owner would let a real bypass move into it unnoticed.`,
      });
    }
  }

  return { ok: diagnostics.length === 0, refCount: refs.length, diagnostics };
}

async function collectShippedFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && isShippedSource(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  await walk(root);
  return files.sort();
}

/** Scan the shipped source under `sourceRoot` for every live primitive reference. */
export async function scanPhaseMutationRefs(
  sourceRoot: string,
): Promise<readonly PhaseMutationRef[]> {
  const files = await collectShippedFiles(sourceRoot);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const module = relative(sourceRoot, file).replaceAll('\\', '/');
      return detectPhaseMutationRefs(module, await readFile(file, 'utf8'));
    }),
  );
  return Object.freeze(perFile.flat());
}

// ─── Detector unit tests ────────────────────────────────────────────────────

describe('detectPhaseMutationRefs', () => {
  it('detects a direct call, a static import and an aliased import', () => {
    const refs = detectPhaseMutationRefs(
      'workflow/rogue.ts',
      [
        "import { executeTransition } from './state-machine.js';",
        "import { executeTransition as et } from './state-machine.js';",
        'const r = executeTransition(hsm, state, target);',
      ].join('\n'),
    );
    expect(refs.map((r) => r.line)).toEqual([1, 2, 3]);
  });

  it('detects a dynamic-import property access (the aliasing bypass shape)', () => {
    const refs = detectPhaseMutationRefs(
      'workflow/rogue.ts',
      "const mod = await import('./state-machine.js');\nmod.executeTransition(hsm, s, t);",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.line).toBe(2);
  });

  it('does NOT count a mention that appears only in a comment', () => {
    const refs = detectPhaseMutationRefs(
      'workflow/cleanup.ts',
      '// Characterized bypass this replaces: cleanup called `executeTransition`\n' +
        '/* executeTransition(hsm, mutableState, …) DIRECTLY */\nexport const x = 1;',
    );
    expect(refs).toEqual([]);
  });

  it('does NOT count a mention that appears only inside a string literal', () => {
    const refs = detectPhaseMutationRefs(
      'workflow/retirement/retirement-safety.ts',
      "const msg = 'getHSMDefinition, executeTransition) and its config registration.';",
    );
    expect(refs).toEqual([]);
  });

  it('does NOT match a longer identifier that merely contains the name', () => {
    const refs = detectPhaseMutationRefs(
      'workflow/rogue.ts',
      'const x = executeTransitionShadow(a, b);\nconst y = preExecuteTransition(c);',
    );
    expect(refs).toEqual([]);
  });

  it('reports the ORIGINAL source line as the snippet, not the masked one', () => {
    const refs = detectPhaseMutationRefs(
      'workflow/rogue.ts',
      "  const r = executeTransition(hsm, state, 'delegate');",
    );
    expect(refs[0]?.snippet).toBe("const r = executeTransition(hsm, state, 'delegate');");
  });
});

describe('runPhaseMutationOwnershipCensus — verdict logic', () => {
  const owners = ['workflow/hsm-transition-guard.ts', 'workflow/state-machine.ts'];
  const owned: PhaseMutationRef[] = [
    { module: 'workflow/state-machine.ts', line: 528, snippet: 'export function …' },
    { module: 'workflow/hsm-transition-guard.ts', line: 617, snippet: 'executeTransition(' },
  ];

  it('passes when every reference is owned and every owner claims one', () => {
    const result = runPhaseMutationOwnershipCensus(owned, owners);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('flags a reference no owner claims as UNAUTHORIZED_PHASE_MUTATION', () => {
    const result = runPhaseMutationOwnershipCensus(
      [...owned, { module: 'workflow/cleanup.ts', line: 303, snippet: 'executeTransition(' }],
      owners,
    );
    expect(result.ok).toBe(false);
    const finding = result.diagnostics.find((d) => d.code === 'UNAUTHORIZED_PHASE_MUTATION');
    expect(finding?.module).toBe('workflow/cleanup.ts');
    expect(finding?.message).toContain('hsm-transition-guard.ts');
  });

  it('flags an owner that claims no reference as STALE_PHASE_MUTATION_OWNER', () => {
    const result = runPhaseMutationOwnershipCensus(
      [{ module: 'workflow/state-machine.ts', line: 528, snippet: 'export function …' }],
      owners,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('STALE_PHASE_MUTATION_OWNER');
  });
});

// ─── Exit proof over the live tree ──────────────────────────────────────────

describe('EXIT PROOF — single phase-mutation authority (DR-7)', () => {
  it('the live shipped source has ZERO unauthorized phase mutations and no stale owner', async () => {
    const refs = await scanPhaseMutationRefs(SRC_ROOT);
    const result = runPhaseMutationOwnershipCensus(refs, PHASE_MUTATION_OWNERS);
    // Surfacing the diagnostics array makes any regression self-describing.
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.refCount).toBeGreaterThan(0);
  });

  it('exactly ONE production module other than the definition invokes the primitive', async () => {
    const refs = await scanPhaseMutationRefs(SRC_ROOT);
    const invokers = [...new Set(refs.map((r) => r.module))]
      .filter((m) => m !== 'workflow/state-machine.ts')
      .sort();
    expect(invokers).toEqual(['workflow/hsm-transition-guard.ts']);
  });

  it('the retired bypass sites (cancel.ts, cleanup.ts) hold no live reference', async () => {
    const refs = await scanPhaseMutationRefs(SRC_ROOT);
    const modules = new Set(refs.map((r) => r.module));
    expect(modules.has('workflow/cancel.ts')).toBe(false);
    expect(modules.has('workflow/cleanup.ts')).toBe(false);
  });

  it('KILL PROBE — a planted direct import outside the guard FAILS the census', async () => {
    const planted = detectPhaseMutationRefs(
      'workflow/rogue-phase-bypass.ts',
      "import { executeTransition } from './state-machine.js';\n" +
        "const r = executeTransition(hsm, state, 'completed');",
    );
    expect(planted).not.toHaveLength(0);

    const live = await scanPhaseMutationRefs(SRC_ROOT);
    const result = runPhaseMutationOwnershipCensus([...live, ...planted], PHASE_MUTATION_OWNERS);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) =>
          d.code === 'UNAUTHORIZED_PHASE_MUTATION' &&
          d.module === 'workflow/rogue-phase-bypass.ts',
      ),
    ).toBe(true);
  });

  it('KILL PROBE — renaming the guard away from the owner set FAILS as stale cover', async () => {
    const live = await scanPhaseMutationRefs(SRC_ROOT);
    const result = runPhaseMutationOwnershipCensus(live, [
      ...PHASE_MUTATION_OWNERS,
      'workflow/hsm-transition-guard.renamed.ts',
    ]);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) =>
          d.code === 'STALE_PHASE_MUTATION_OWNER' &&
          d.module === 'workflow/hsm-transition-guard.renamed.ts',
      ),
    ).toBe(true);
  });

  it('every declared owner is a real shipped module in the scan root', async () => {
    const files = await collectShippedFiles(SRC_ROOT);
    const modules = new Set(files.map((f) => relative(SRC_ROOT, f).replaceAll('\\', '/')));
    for (const owner of PHASE_MUTATION_OWNERS) {
      expect(modules.has(owner)).toBe(true);
    }
  });
});
