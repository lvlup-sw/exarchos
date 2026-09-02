// ─── P06-06 — Remediation purity census (structural conformance) ─────────────
//
// The P06-06 exit proof demands that remediation be DATA, never a mutation. A
// behavioural test can show a given call mutates nothing; this module proves the
// stronger STRUCTURAL property — that the remediation/explanation modules cannot
// mutate state because they do not IMPORT any state-mutation surface at all.
//
// It follows the repo's established census pattern (`architecture/effect-ledger.ts`,
// `architecture/vcs-ownership.ts`, `verbs/gates/gate-ownership-census.ts`): a
// comment/string-aware scan of a module's own import surface yielding a typed
// verdict, so a regression (a new import that reaches the event store, the
// filesystem, a process, the network, or a phase/transition mutation) trips it
// rather than a hand-maintained mirror. The lexical half of that scan is a
// caller-supplied port — see the note above {@link ImportLexer}.
//
// Pure: the scan takes SOURCE TEXT and returns a verdict. It performs NO I/O
// itself — the caller (the test) reads the module file — so this module never
// itself acquires the effect surface it forbids.

/**
 * Import specifiers that would give a module the ability to WRITE admission
 * state (or perform any external effect). A remediation/explanation module that
 * imports any of these is, by construction, no longer pure data. Matched as a
 * substring of the resolved specifier (so `../../events/atomic-appender.js`
 * is caught by `events/`).
 */
export const FORBIDDEN_IMPORT_MARKERS: readonly string[] = Object.freeze([
  // Persistence / event log — the state-mutation substrate.
  'events/',
  'atomic-appender',
  // The transition chokepoint itself (VALUES only — the sole state mutator).
  './transition-command',
  // Prior-state folds are read models, but a remediation has no business
  // reaching for phase-attempt mutation surfaces.
  'phase-attempt-state',
  // Saga / compensation mutation.
  'compensation',
  'workflow/cancel',
  // VCS / worktree mutation.
  '/vcs/',
  'mutation-owner',
  // Raw external effects.
  'node:fs',
  'node:child_process',
  'node:net',
  'node:http',
  'node:https',
  'node:dgram',
  'node:tls',
  'undici',
]);

/** A single forbidden import found in a scanned module. */
export interface ForbiddenImport {
  readonly module: string;
  readonly specifier: string;
  readonly marker: string;
}

export interface RemediationPurityResult {
  readonly ok: boolean;
  readonly importCount: number;
  readonly forbidden: readonly ForbiddenImport[];
}

// The marker check below is a positive allow-by-absence — anything not matching
// a forbidden marker is inert. What it ranges over is the module's import
// surface, and answering "what does this module import?" is a question about
// TypeScript's grammar rather than about admission, so this module asks it of a
// caller-supplied PORT and owns no lexing mechanism at all (DR-2).
//
// ── What the port replaced, and what that cost ──────────────────────────────
// Until task 072 this file carried its own comment/string-aware character walk —
// the second of four near-duplicates in this package — introduced with the note
// that it "deliberately re-implements only the minimal specifier extraction it
// needs … so it depends on nothing". Measured on task 065's adversarial inputs
// it was wrong in BOTH directions, and it had no regex-literal state at all,
// making it the weakest of the four:
//
//   • FALSE NEGATIVE, and this is the dangerous direction for a purity census.
//     A regex literal holding a backtick opened a phantom template that ran to
//     EOF, hiding a real `import { readFile } from 'node:fs'` — a FORBIDDEN
//     marker. The verdict was `ok: true` for a module that reaches the
//     filesystem, which is the one answer this census exists to prevent.
//   • FALSE POSITIVE. A template nested inside a `${…}` substitution read as
//     code, so its text was scanned and the census reported a
//     `node:child_process` import in a module that imports nothing.
//   • `import('p').T` TYPE QUERIES were charged as VALUE imports. They are fully
//     erased, so `export type H = import('node:fs').Stats` failed the audit for
//     an import that emits nothing at all.
//
// The port declared below is the MINIMAL shape this census needs, declared here
// rather than imported from `architecture/effect-ledger.ts`'s wider
// `ModuleLexer`: naming an architecture-census module from `workflow/admission/`
// would be a real cross-layer coupling, where this is two fields and no
// dependency. One implementation — `test-helpers/module-lexer.ts` — satisfies
// this and both sibling ports structurally, so there is still exactly one lexer.

/** One import/export specifier occurrence, as the port reports it. */
export interface LexedImportRef {
  /** The literal specifier text (`node:fs`, `./x.js`). */
  readonly specifier: string;
  /**
   * True for a form that is fully ERASED at emit — `import type … from '…'`,
   * `export type … from '…'`, and an `import('…')` type query. Such a form
   * carries no runtime binding, so it cannot mutate anything; auditing it would
   * flag a harmless `import type { TransitionDecided }` as if it reached the
   * mutator.
   */
  readonly typeOnly: boolean;
}

/** Everything this census needs to know about one module's lexical structure. */
export interface LexedImports {
  readonly imports: readonly LexedImportRef[];
}

/**
 * The lexer port. REQUIRED wherever it appears: a default would have to be
 * either the retired heuristic (the defect, retained) or a throwing stub, and an
 * optional lexer is how a caller silently gets the old answers back.
 */
export type ImportLexer = (source: string, fileName?: string) => LexedImports;

/**
 * Every module specifier introduced by a VALUE import, as `lex` resolved them.
 *
 * An ACCESSOR, not a lexer: it holds no knowledge of TypeScript's grammar and
 * must never re-acquire any. The one judgement it makes is the census's own —
 * type-only forms are erased, so they are dropped here rather than in the port,
 * which reports the full surface because a sibling consumer needs it.
 */
export function extractImportSpecifiers(source: string, lex: ImportLexer): string[] {
  return lex(source)
    .imports.filter((ref) => !ref.typeOnly)
    .map((ref) => ref.specifier);
}

/**
 * Audit one module's source for forbidden imports. Pure: source text in, verdict
 * out. `ok === true` iff the module imports nothing on the deny-list.
 */
export function auditRemediationPurity(
  module: string,
  source: string,
  lex: ImportLexer,
  markers: readonly string[] = FORBIDDEN_IMPORT_MARKERS,
): RemediationPurityResult {
  const specifiers = extractImportSpecifiers(source, lex);
  const forbidden: ForbiddenImport[] = [];
  for (const specifier of specifiers) {
    for (const marker of markers) {
      if (specifier.includes(marker)) {
        forbidden.push({ module, specifier, marker });
      }
    }
  }
  return Object.freeze({
    ok: forbidden.length === 0,
    importCount: specifiers.length,
    forbidden: Object.freeze(forbidden),
  });
}
