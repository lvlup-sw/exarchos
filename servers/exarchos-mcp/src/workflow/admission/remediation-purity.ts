// ─── P06-06 — Remediation purity census (structural conformance) ─────────────
//
// The P06-06 exit proof demands that remediation be DATA, never a mutation. A
// behavioural test can show a given call mutates nothing; this module proves the
// stronger STRUCTURAL property — that the remediation/explanation modules cannot
// mutate state because they do not IMPORT any state-mutation surface at all.
//
// It follows the repo's established census pattern (`architecture/effect-ledger.ts`,
// `architecture/vcs-ownership.ts`, `orchestrate/gate-ownership-census.ts`): a
// comment/string-aware scan of a module's own import surface yielding a typed
// verdict, so a regression (a new import that reaches the event store, the
// filesystem, a process, the network, or a phase/transition mutation) trips it
// rather than a hand-maintained mirror.
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

// A `.js` specifier a remediation import may legitimately reference: the marker
// check below is a positive allow-by-absence — anything not matching a forbidden
// marker is inert. This detector deliberately re-implements only the minimal
// specifier extraction it needs (comment/string-aware) so it depends on nothing.

const IDENT = /[A-Za-z0-9_$]/;
const isIdent = (c: string | undefined): boolean => c !== undefined && IDENT.test(c);
const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/**
 * Extract every module specifier introduced by a VALUE import at CODE position —
 * `from '…'`, side-effect `import '…'`, dynamic `import('…')`, or `require('…')`
 * — via a comment/string-aware walk so a specifier inside a string literal or a
 * doc comment is not mistaken for a real import.
 *
 * TYPE-ONLY imports/exports (`import type … from '…'`, `export type … from '…'`)
 * are DELIBERATELY skipped: they are fully erased at compile time and carry no
 * runtime binding, so they cannot mutate anything. Auditing them would flag a
 * harmless `import type { TransitionDecided }` as if it reached the mutator.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const n = source.length;
  let i = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  // True while inside the current import/export statement's `type` modifier.
  let pendingTypeOnly = false;

  const readStringAt = (start: number): { value: string; end: number } | undefined => {
    const q = source[start];
    if (q !== '"' && q !== "'" && q !== '`') return undefined;
    let j = start + 1;
    let val = '';
    while (j < n) {
      const c = source[j] ?? '';
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === q) return { value: val, end: j };
      val += c;
      j += 1;
    }
    return undefined;
  };

  const recordFrom = (kw: 'from' | 'require'): boolean => {
    let j = i + kw.length;
    while (isWs(source[j])) j += 1;
    if (kw === 'require' && source[j] === '(') {
      j += 1;
      while (isWs(source[j])) j += 1;
    }
    const str = readStringAt(j);
    if (str === undefined) return false;
    if (!pendingTypeOnly) specs.push(str.value);
    pendingTypeOnly = false;
    i = str.end + 1;
    return true;
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      i += 1;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }

    if (!isIdent(source[i - 1])) {
      const isImport = source.startsWith('import', i) && !isIdent(source[i + 6]);
      const isExport = source.startsWith('export', i) && !isIdent(source[i + 6]);
      if (isImport || isExport) {
        // A fresh import/export statement — re-derive its type-only status so a
        // prior `export type X = Y;` never leaks into the next statement's `from`.
        pendingTypeOnly = false;
        let p = i + 'import'.length;
        while (isWs(source[p])) p += 1;
        if (source.startsWith('type', p) && !isIdent(source[p + 4])) pendingTypeOnly = true;

        if (isImport) {
          // Side-effect `import '…'` or dynamic `import('…')` — a value import.
          let j = i + 'import'.length;
          while (isWs(source[j])) j += 1;
          if (source[j] === '(') {
            j += 1;
            while (isWs(source[j])) j += 1;
          }
          const str = readStringAt(j);
          if (str !== undefined) {
            if (!pendingTypeOnly) specs.push(str.value);
            pendingTypeOnly = false;
            i = str.end + 1;
            continue;
          }
        }
        i += 'import'.length;
        continue;
      }

      if (source.startsWith('from', i) && !isIdent(source[i + 4])) {
        if (recordFrom('from')) continue;
      } else if (source.startsWith('require', i) && !isIdent(source[i + 7])) {
        if (recordFrom('require')) continue;
      }
    }
    i += 1;
  }
  return specs;
}

/**
 * Audit one module's source for forbidden imports. Pure: source text in, verdict
 * out. `ok === true` iff the module imports nothing on the deny-list.
 */
export function auditRemediationPurity(
  module: string,
  source: string,
  markers: readonly string[] = FORBIDDEN_IMPORT_MARKERS,
): RemediationPurityResult {
  const specifiers = extractImportSpecifiers(source);
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
