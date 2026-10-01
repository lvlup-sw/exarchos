/**
 * A structural census that proves remediation is data and never a mutation.
 *
 * The remediation and explanation modules must import no state-mutation surface.
 * The census scans the value imports of a module and returns a typed verdict.
 * An import that matches a forbidden marker fails the census.
 * The scan takes source text and does no I/O. The caller reads the file.
 */

/**
 * Import specifiers that let a module write admission state or cause an external effect.
 * The groups are the event log, the transition command, phase-attempt state, compensation and cancel, VCS mutation, and raw I/O.
 * A marker matches as a substring, so `events/` catches `../../events/atomic-appender.js`.
 */
export const FORBIDDEN_IMPORT_MARKERS: readonly string[] = Object.freeze([
  'events/',
  'atomic-appender',
  './transition-command',
  'phase-attempt-state',
  'compensation',
  'workflow/cancel',
  '/vcs/',
  'mutation-owner',
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

/** One import or export specifier, as the lexer port reports it. */
export interface LexedImportRef {
  /** The literal specifier text (`node:fs`, `./x.js`). */
  readonly specifier: string;
  /**
   * True for a form that emit erases: `import type`, `export type`, and an `import('…')` type query.
   * Such a form has no runtime binding, so it cannot mutate state.
   */
  readonly typeOnly: boolean;
}

/** The lexical facts about one module that the census needs. */
export interface LexedImports {
  readonly imports: readonly LexedImportRef[];
}

/**
 * The lexer port. The census owns no lexer and asks the caller to parse the import surface.
 * The port is required everywhere, because a default lexer can silently give wrong answers.
 * `tools/test-helpers/module-lexer.ts` implements it.
 */
export type ImportLexer = (source: string, fileName?: string) => LexedImports;

/**
 * Every specifier of a value import, as `lex` reports it.
 * This function holds no grammar knowledge. It drops type-only forms here, because the port reports them for other consumers.
 */
export function extractImportSpecifiers(source: string, lex: ImportLexer): string[] {
  return lex(source)
    .imports.filter((ref) => !ref.typeOnly)
    .map((ref) => ref.specifier);
}

/** Audits the source of one module. `ok` is true only when it imports nothing on the deny-list. */
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
