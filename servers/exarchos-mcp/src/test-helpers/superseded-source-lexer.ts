// ─── The RETIRED effect-ledger lexer, kept only so the gap can be measured ───
//
// Until task 065 these two walks lived in `architecture/effect-ledger.ts` and
// answered, for shipped source, "what does this module import?" and "which of
// its characters are code?". They are reproduced here VERBATIM — same control
// flow, same conservative regex-versus-division rule, same line-bounded quotes —
// for exactly one purpose: `effect-ledger.test.ts`'s kill fixture asserts what
// THIS answers and what the real parse answers on the same input, so the size
// and the DIRECTION of the defect are pinned in the tree rather than described
// in a commit message.
//
// A port that is never shown to differ from the heuristic it replaced has not
// been shown to be needed. This file is the other half of that showing.
//
// ── It exports no `ModuleLexer`, on purpose ─────────────────────────────────
// The two halves are exported SEPARATELY and neither is typed as the port, so
// running a census through the retired lexer takes a deliberate, named act —
// `effect-ledger.test.ts` assembles one, calls it `SUPERSEDED_LEXER`, and uses
// it for exactly one thing: showing what the census USED to answer. Nothing can
// pick this up by autocomplete, and a test pins that no shipped module imports
// this file at all. Retiring a defect and leaving it casually callable is how it
// comes back.
//
// Do not fix bugs in this file. Its value is being wrong in precisely the way
// the shipped tree used to be wrong.

/** One import/export specifier occurrence, as the retired walk reported it. */
export interface SupersededImportRef {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const isIdentChar = (c: string | undefined): boolean => c !== undefined && IDENT_CHAR.test(c);
const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/**
 * The retired `extractImports`: a comment/string/regex-aware character walk.
 *
 * Its own header claimed two correctness properties. Both are false, and the
 * kill fixture asserts the counterexamples:
 *
 *   - "when in doubt it treats `/` as division, which merely restores the old
 *     behaviour instead of swallowing real code" — treating `/` as division at
 *     the head of a real regex literal lets a quote character INSIDE that regex
 *     open a phantom string. With a backtick that phantom string is a template
 *     literal, which is not line-bounded, so it runs to EOF and swallows every
 *     import after it.
 *   - "`'`/`"` strings cannot span a raw newline in JS. Terminating them at
 *     end-of-line caps any residual desync at one line" — true for `'`/`"`, and
 *     the exemption it grants template literals is where the cap fails.
 */
export function supersededExtractImports(source: string): SupersededImportRef[] {
  const refs: SupersededImportRef[] = [];
  const n = source.length;
  let i = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  /** Last significant CODE character — decides regex-vs-division for `/`. */
  let lastSignificant = '';
  /** True while the current import/export statement carries a `type` modifier. */
  let pendingTypeOnly = false;

  const startsRegex = (): boolean =>
    lastSignificant === '' || !/[A-Za-z0-9_$)\]]/.test(lastSignificant);

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
      // A specifier literal never spans a raw newline; bail rather than run away.
      if (c === '\n' && q !== '`') return undefined;
      if (c === q) return { value: val, end: j };
      val += c;
      j += 1;
    }
    return undefined;
  };

  const record = (specifier: string): void => {
    refs.push({ specifier, typeOnly: pendingTypeOnly });
    pendingTypeOnly = false;
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
    if (regex) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      // A raw newline cannot appear in a regex literal — bail out rather than
      // run away, so a misjudged `/` costs at most one line.
      if (ch === '\n') regex = false;
      else if (ch === '[') regexClass = true;
      else if (ch === ']') regexClass = false;
      else if (ch === '/' && !regexClass) regex = false;
      i += 1;
      continue;
    }
    if (quote !== null) {
      // `'`/`"` are line-bounded in JS; a newline means the lexer desynced, so
      // resynchronise instead of consuming the rest of the file as string body.
      if (ch === '\n' && quote !== '`') {
        quote = null;
        i += 1;
        continue;
      }
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
    if (ch === '/' && startsRegex()) {
      regex = true;
      regexClass = false;
      lastSignificant = ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      lastSignificant = ch;
      i += 1;
      continue;
    }

    // Code position: a keyword that introduces a specifier, at a word boundary.
    if (!isIdentChar(source[i - 1])) {
      const isImport = source.startsWith('import', i) && !isIdentChar(source[i + 6]);
      const isExport = source.startsWith('export', i) && !isIdentChar(source[i + 6]);
      if (isImport || isExport) {
        // A fresh import/export statement — re-derive its type-only status so a
        // prior `export type X = Y;` never leaks into the next `from`.
        pendingTypeOnly = false;
        let p = i + 'import'.length;
        while (isSpace(source[p])) p += 1;
        if (source.startsWith('type', p) && !isIdentChar(source[p + 4])) pendingTypeOnly = true;

        if (isImport) {
          // Side-effect `import '…'` or dynamic `import('…')` — a value import.
          let j = i + 'import'.length;
          while (isSpace(source[j])) j += 1;
          if (source[j] === '(') {
            j += 1;
            while (isSpace(source[j])) j += 1;
          }
          const str = readStringAt(j);
          if (str !== undefined) {
            record(str.value);
            i = str.end + 1;
            lastSignificant = source[i - 1] ?? '';
            continue;
          }
        }
        i += 'import'.length;
        lastSignificant = 't';
        continue;
      }

      let kw: 'from' | 'require' | null = null;
      if (source.startsWith('from', i) && !isIdentChar(source[i + 4])) kw = 'from';
      else if (source.startsWith('require', i) && !isIdentChar(source[i + 7])) kw = 'require';

      if (kw !== null) {
        let j = i + kw.length;
        while (isSpace(source[j])) j += 1;
        if (kw === 'require' && source[j] === '(') {
          j += 1;
          while (isSpace(source[j])) j += 1;
        }
        const str = readStringAt(j);
        if (str !== undefined) {
          record(str.value);
          i = str.end + 1;
          lastSignificant = source[i - 1] ?? '';
          continue;
        }
      }
    }
    if (ch !== undefined && !/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return refs;
}

/**
 * The retired `maskNonCode`: a near-duplicate of the walk above that blanked
 * strings, templates, comments and regex literals.
 *
 * Its documented trust boundary read: "TEMPLATE-LITERAL INTERPOLATION. maskNonCode
 * masks a template literal whole, so an ambient-global call written inside `${…}`
 * is masked with it." It does not. Every backtick TOGGLES the state, so the body
 * of a template nested inside a substitution is un-masked and read as code — the
 * exact inverse of the claim.
 */
export function supersededMaskNonCode(source: string): string {
  const out: string[] = [];
  const n = source.length;
  let i = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  let lastSignificant = '';

  const blank = (ch: string | undefined): void => {
    out.push(ch === '\n' ? '\n' : ' ');
  };
  const startsRegex = (): boolean =>
    lastSignificant === '' || !/[A-Za-z0-9_$)\]]/.test(lastSignificant);

  while (i < n) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      blank(ch);
      i += 1;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        out.push('  ');
        i += 2;
        continue;
      }
      blank(ch);
      i += 1;
      continue;
    }
    if (regex) {
      blank(ch);
      if (ch === '\\') {
        if (i + 1 < n) blank(source[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '\n') regex = false;
      else if (ch === '[') regexClass = true;
      else if (ch === ']') regexClass = false;
      else if (ch === '/' && !regexClass) regex = false;
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === '\n' && quote !== '`') {
        quote = null;
        out.push('\n');
        i += 1;
        continue;
      }
      blank(ch);
      if (ch === '\\') {
        if (i + 1 < n) blank(source[i + 1]);
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      out.push('  ');
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      out.push('  ');
      i += 2;
      continue;
    }
    if (ch === '/' && startsRegex()) {
      regex = true;
      regexClass = false;
      out.push(' ');
      lastSignificant = ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out.push(' ');
      lastSignificant = ch;
      i += 1;
      continue;
    }
    out.push(ch);
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return out.join('');
}
