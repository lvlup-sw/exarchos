// ─── DR-1: the compile-time relocation substitution proof (task 007) ─────────
//
// THE CLAIM: declaration storage can relocate into the #1258 Workflow Builder IR
// **without editing any consumer**.
//
// ## Why this proof is shaped the way it is
//
// An earlier revision of task 007 asserted "zero consumer diff across the 10
// consumers" from inside a RUNTIME fixture that never edits source. That is true
// by construction — a fixture which cannot produce a diff cannot report one — so
// the proof could not fail, and a proof that cannot fail is exactly the defect
// class this program exists to remove. It is not rebuilt here.
//
// This is the rung-2, compile-time replacement:
//
//   1. **Substitution.** The module behind the accessor's `DeclarationSource`
//      port is swapped from a registry-shaped store to the in-memory IR, and
//      `tsc` must pass over byte-identical consumer sources.
//   2. **Falsifier.** A seeded consumer that imports the storage module directly
//      must FAIL that same substitution. This is what the old version lacked and
//      what makes the proof capable of being wrong.
//   3. **Non-empty denominator.** A run resolving zero consumers FAILS rather
//      than reporting a clean compile.
//
// ## Which `tsc`-driving approach, and why
//
// The assertions are driven through the TypeScript **compiler API** over virtual
// probe modules, not placed as `Expect<…>` aliases in a shipped source file.
// Both idioms exist in this repo (`_Pola*` in `capabilities/resolver.ts` and the
// proofs at the foot of `contract/declaration.ts` are the latter; the scope probe
// in `projections/types.test.ts` is the former). The compiler API is the only one
// that can express THIS claim, for a reason specific to it:
//
//   A type-alias proof lives in ONE compilation. Relocation is a claim about TWO
//   — the same consumer text compiling against two different storage modules —
//   and about a NEGATIVE (the storage-coupled consumer failing in the second).
//   A source file that failed to compile could not be committed, so the falsifier
//   has nowhere to live except a program the test constructs and compiles itself.
//
// The standing caveat that motivates the choice applies to both: `tsconfig.json`
// excludes `**/*.test.ts` AND `**/__tests__/**`, and vitest typecheck mode is
// off, so a type error in this file would never fail the build. Nothing here
// relies on this file being type-checked; the compiler is invoked explicitly and
// its diagnostics are the assertion subject.
//
// ## Asserting the SPECIFIC diagnostic
//
// An unrelated compile failure must not read as a pass. The falsifier assertion
// pins three things together — the diagnostic CODE (TS2305, "has no exported
// member"), the FILE it is reported against (the seeded consumer, not some other
// probe), and the SYMBOL named in its message (`REGISTRY_TABLE`) — and pins the
// full diagnostic-code list to exactly `[2305]`, so a typo that broke every probe
// would redden this test rather than satisfy it.
//
// ## Two independent authorities
//
// The seeded violation is judged twice, by oracles that share no code: the
// TypeScript checker (does it compile?) and the static declaration-seam census in
// `architecture/layer-boundaries-seam.ts` (does the import graph show a consumer
// touching storage?). The census is REUSED, not re-implemented — DR-1's rule is
// that this program adds no new enforcement instrument.
//
// @oracle-sources: ./fixtures/in-memory-ir.ts, ../../../src/architecture/layer-boundaries-seam.ts

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

import {
  detectDeclarationSeamUsage,
  runDeclarationSeamCensus,
  type DeclarationSeamRule,
  type DeclarationSeamScan,
  type DeclarationSeamUsage,
} from '../../../src/architecture/layer-boundaries-seam.js';
import { lexModule } from '../../../tools/test-helpers/module-lexer.js';
import { openDeclarationSeam } from '../../../src/contract/declaration-seam.js';
import {
  COMPOSITION_ROOT,
  COMPOSITION_ROOT_MODULE,
  DIRECT_STORAGE_CONSUMER,
  DIRECT_STORAGE_CONSUMER_MODULE,
  IR_NODES,
  PROBE_DIR,
  RELOCATED_STORAGE_SYMBOL,
  SEAM_CONSUMERS,
  STORE_AFTER_RELOCATION,
  STORE_BEFORE_RELOCATION,
  STORE_MODULE,
  openInMemoryIr,
} from './fixtures/in-memory-ir.js';

// ─── The compiler harness ───────────────────────────────────────────────────

/**
 * Absolute path of `src/${PROBE_DIR}`, where probes are rooted.
 *
 * This is a VIRTUAL directory — task 030 moved the fixture module itself into
 * `tests/unit/contract/fixtures/`, and nothing sits here on disk any more. It
 * stays the probe root because the probe sources are src-tree consumers in
 * miniature: their `../../declaration.js` specifiers, and the module ids the
 * declaration-seam census resolves them to, are both relative to {@link
 * PROBE_DIR}. Rooting the overlay at the fixture's real address instead would
 * make `tsc` and the census disagree about the same strings — the census would
 * stop recognising a contract import and quietly resolve zero consumers.
 * Only the one probe that loads the real fixture reaches back out (see
 * `SUBSTITUTED_COMPOSITION_ROOT`).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'src', PROBE_DIR);

/**
 * Probe compiler options MIRROR `tsconfig.json`'s strictness
 * — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — rather
 * than the looser `strict`-only set a probe could get away with. A relocation
 * that only survives under weaker flags than the project actually builds with
 * would be a proof about a program nobody ships.
 */
const PROBE_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts'],
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
};

/**
 * Type-check an overlay of virtual modules rooted in the real fixtures
 * directory, so their relative specifiers resolve to the REAL modules under
 * test (`../../declaration.js`, `../../declaration-seam.js`,
 * `./in-memory-ir.js`). Nothing is written to disk.
 */
function typecheckOverlay(overlay: ReadonlyMap<string, string>): readonly ts.Diagnostic[] {
  const virtualFiles = new Map<string, string>();
  for (const [name, source] of overlay) {
    virtualFiles.set(path.resolve(FIXTURES_DIR, name), source);
  }

  const host = ts.createCompilerHost(PROBE_COMPILER_OPTIONS, true);
  const readReal = host.getSourceFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const virtual = virtualFiles.get(path.resolve(fileName));
    if (virtual !== undefined) {
      return ts.createSourceFile(fileName, virtual, languageVersion, true);
    }
    return readReal(fileName, languageVersion, onError, shouldCreate);
  };
  host.fileExists = (fileName) =>
    virtualFiles.has(path.resolve(fileName)) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    virtualFiles.get(path.resolve(fileName)) ?? ts.sys.readFile(fileName);

  const program = ts.createProgram([...virtualFiles.keys()], PROBE_COMPILER_OPTIONS, host);
  return ts.getPreEmitDiagnostics(program);
}

/** A diagnostic reduced to the three facts the assertions pin. */
interface ProbeDiagnostic {
  readonly code: number;
  /** Probe-relative file name, or `'<none>'` for a program-level diagnostic. */
  readonly file: string;
  readonly text: string;
}

function describeDiagnostics(diagnostics: readonly ts.Diagnostic[]): readonly ProbeDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    file:
      diagnostic.file === undefined
        ? '<none>'
        : path.relative(FIXTURES_DIR, diagnostic.file.fileName).split(path.sep).join('/'),
    text: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  }));
}

/** A stable digest of the exact consumer text a substitution run compiled. */
function digestOf(sources: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const name of [...sources.keys()].sort()) {
    hash.update(name);
    hash.update(' ');
    hash.update(sources.get(name) ?? '');
    hash.update(' ');
  }
  return hash.digest('hex');
}

/** What one half of the substitution compiled, and what came back. */
interface SubstitutionRun {
  readonly consumerModules: readonly string[];
  /** Digest of the consumer sources — the evidence they were not edited. */
  readonly consumerDigest: string;
  readonly diagnostics: readonly ProbeDiagnostic[];
}

/**
 * Compile the consumer corpus against ONE storage implementation.
 *
 * **Fails closed on an empty denominator.** A program containing a store and no
 * consumers type-checks clean, so a harness that accepted one would report
 * relocation "proven" having checked nothing. `RelocationProof_ZeroConsumers-
 * Resolved_FailsClosed` pins both halves of that: this throw, and the fact that
 * the underlying compile really is clean.
 */
function runSubstitution(
  storeSource: string,
  consumers: ReadonlyMap<string, string>,
): SubstitutionRun {
  if (consumers.size === 0) {
    throw new Error(
      'relocation proof: substitution resolved zero consumers. A store compiled with no ' +
        'consumers type-checks clean and would report relocation proven having checked ' +
        'nothing, so the run is rejected rather than trusted.',
    );
  }

  const overlay = new Map<string, string>([
    [STORE_MODULE, storeSource],
    [COMPOSITION_ROOT_MODULE, COMPOSITION_ROOT],
    ...consumers,
  ]);

  return {
    consumerModules: [...consumers.keys()].sort(),
    consumerDigest: digestOf(consumers),
    diagnostics: describeDiagnostics(typecheckOverlay(overlay)),
  };
}

// ─── The seam rule the census authority is run under ────────────────────────
//
// A rule pointed at the PROBE modules rather than the shipped stores, so the
// existing census in `architecture/layer-boundaries-seam.ts` judges the seeded
// violation. The detector, the diagnostics and the vacuity guards are all the
// shipped ones — only the subject population is substituted.

const probeModule = (name: string): string => `${PROBE_DIR}/${name}`;

const PROBE_SEAM_RULE: DeclarationSeamRule = Object.freeze({
  accessor: 'contract/declaration-seam.ts',
  contractModules: Object.freeze(['contract/declaration.ts', 'contract/declaration-seam.ts']),
  storage: Object.freeze([
    {
      module: probeModule(STORE_MODULE),
      symbol: RELOCATED_STORAGE_SYMBOL,
      note: 'The probe store, standing in for registry.ts / event-store/schemas.ts.',
    },
  ]),
  // The composition root imports both sides BY DESIGN — wiring a store to the
  // accessor is the one job that legitimately does. Declaring it here is what
  // separates "wiring" from "a consumer reaching into storage"; without the
  // exemption the census could not tell them apart, and the falsifier's
  // detection would prove nothing specific.
  sourceAdapters: Object.freeze([
    {
      module: probeModule(COMPOSITION_ROOT_MODULE),
      note: 'Composition root: lifts the store into the seam. The only legitimate double import.',
    },
  ]),
});

/** Classify probe sources with the SHIPPED detector — no parallel instrument. */
function scanProbes(sources: ReadonlyMap<string, string>): DeclarationSeamScan {
  const usages: DeclarationSeamUsage[] = [];
  for (const name of [...sources.keys()].sort()) {
    const usage = detectDeclarationSeamUsage(
      probeModule(name),
      sources.get(name) ?? '',
      lexModule, PROBE_SEAM_RULE,
    );
    if (usage !== undefined) usages.push(usage);
  }
  return {
    usages,
    storage: [
      {
        module: probeModule(STORE_MODULE),
        symbol: RELOCATED_STORAGE_SYMBOL,
        resolved: true,
      },
    ],
    accessorPresent: true,
  };
}

// ─── The proof ──────────────────────────────────────────────────────────────

describe('DR-1 relocation proof — compile-time storage substitution', () => {
  it('RelocationProof_StorageSubstituted_CompilesWithNoConsumerEdit', () => {
    // The substitution destination must be a REAL store, not a stub — the whole
    // proof is worthless if the IR cannot actually back the seam. Opened through
    // the shipped accessor and checked against a hand-written key list.
    const irSeam = openDeclarationSeam(openInMemoryIr(IR_NODES));
    expect(irSeam.keys()).toEqual(['event:task.assigned', 'event:worktree.acquired']);
    expect(irSeam.get('event', 'task.assigned')?.authority).toBe('registry');

    // BEFORE: the pre-relocation world compiles. This is the positive control —
    // without it, a broken harness (bad path, bad options) that errored on
    // everything would make the AFTER assertion below meaningless.
    const before = runSubstitution(STORE_BEFORE_RELOCATION, SEAM_CONSUMERS);
    expect(before.diagnostics).toEqual([]);

    // AFTER: swap the storage implementation behind the port. Same consumer
    // text, different store. THIS is the relocation claim.
    const after = runSubstitution(STORE_AFTER_RELOCATION, SEAM_CONSUMERS);
    expect(after.diagnostics).toEqual([]);

    // "With no consumer edit" is evidence, not narration: the two runs are
    // pinned to the same consumer digest, so a future revision that quietly
    // gave each variant its own consumer text would redden this.
    expect(after.consumerDigest).toBe(before.consumerDigest);

    // Non-empty denominator for THIS run (see the dedicated test for the guard).
    expect(before.consumerModules).toEqual(after.consumerModules);
    expect(before.consumerModules.length).toBeGreaterThan(0);
  });

  it('RelocationProof_ConsumerImportingStorageDirectly_FailsToCompile', () => {
    // Seed a consumer that reads the seam AND reaches into storage.
    const seeded = new Map<string, string>([
      ...SEAM_CONSUMERS,
      [DIRECT_STORAGE_CONSUMER_MODULE, DIRECT_STORAGE_CONSUMER],
    ]);

    // AUTHORITY 1 — the TypeScript checker.
    //
    // Control: the seeded consumer is a REALISTIC module, not a broken one. It
    // compiles clean before relocation, which is precisely why it is dangerous:
    // nothing stops somebody writing it today.
    const before = runSubstitution(STORE_BEFORE_RELOCATION, seeded);
    expect(before.diagnostics).toEqual([]);

    // The falsifier fires: the same substitution that left every seam-abiding
    // consumer untouched breaks this one, because `REGISTRY_TABLE` ceased to
    // exist when the declarations moved into the IR.
    const after = runSubstitution(STORE_AFTER_RELOCATION, seeded);

    // Pin the SPECIFIC diagnostic, not "some error occurred". The whole code
    // list is pinned, so an unrelated compile failure cannot read as a pass.
    expect(after.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([2305]);

    const failure = after.diagnostics[0];
    expect(failure?.file).toBe(DIRECT_STORAGE_CONSUMER_MODULE);
    expect(failure?.text).toContain(RELOCATED_STORAGE_SYMBOL);
    expect(failure?.text).toContain('has no exported member');

    // AUTHORITY 2 — the shipped static census, which shares no code with the
    // checker: it reads the import graph, not the type graph.
    const census = runDeclarationSeamCensus(scanProbes(seeded), PROBE_SEAM_RULE);
    const directReads = census.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'DIRECT_STORAGE_READ',
    );
    expect(directReads.map((diagnostic) => diagnostic.module)).toEqual([
      probeModule(DIRECT_STORAGE_CONSUMER_MODULE),
    ]);

    // Discrimination check: the composition root imports storage too, and is NOT
    // flagged. Without this the census could be a blunt "any storage import is
    // bad" rule, which would prove nothing about consumers specifically.
    const compositionRootFlagged = directReads.some(
      (diagnostic) => diagnostic.module === probeModule(COMPOSITION_ROOT_MODULE),
    );
    expect(compositionRootFlagged).toBe(false);

    // And the seam-abiding consumers survive both authorities.
    const seamAbiding = new Map(SEAM_CONSUMERS);
    const cleanCensus = runDeclarationSeamCensus(scanProbes(seamAbiding), PROBE_SEAM_RULE);
    expect(
      cleanCensus.diagnostics.filter((diagnostic) => diagnostic.code === 'DIRECT_STORAGE_READ'),
    ).toEqual([]);
  });

  it('RelocationProof_ZeroConsumersResolved_FailsClosed', () => {
    // First, demonstrate WHY the guard is needed rather than asserting it is:
    // a program with the relocated store and NO consumers type-checks perfectly
    // clean. A harness without a denominator guard would read that as success.
    const storeOnly = new Map<string, string>([
      [STORE_MODULE, STORE_AFTER_RELOCATION],
      [COMPOSITION_ROOT_MODULE, COMPOSITION_ROOT],
    ]);
    expect(describeDiagnostics(typecheckOverlay(storeOnly))).toEqual([]);

    // So the substitution refuses the run instead of passing it.
    expect(() => runSubstitution(STORE_AFTER_RELOCATION, new Map())).toThrow(
      /resolved zero consumers/i,
    );

    // The shipped census fails closed on the same condition, through its own
    // EMPTY_SEAM_DENOMINATOR diagnostic — the vacuity guard is reused, not
    // re-invented.
    const emptyPopulation = runDeclarationSeamCensus(
      { usages: [], storage: scanProbes(SEAM_CONSUMERS).storage, accessorPresent: true },
      PROBE_SEAM_RULE,
    );
    expect(emptyPopulation.ok).toBe(false);
    expect(emptyPopulation.consumerCount).toBe(0);
    expect(
      emptyPopulation.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'EMPTY_SEAM_DENOMINATOR' && diagnostic.population === 'consumers',
      ),
    ).toBe(true);

    // Positive control: with the real probe population the same census resolves
    // a non-zero denominator, so the guard above is not firing for everything.
    const populated = runDeclarationSeamCensus(scanProbes(SEAM_CONSUMERS), PROBE_SEAM_RULE);
    expect(populated.consumerCount).toBeGreaterThan(0);
  });
});
