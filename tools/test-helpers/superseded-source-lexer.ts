/**
 * The retired effect-ledger lexer, kept only to measure the gap. These two walks once answered
 * "what does this module import?" and "which characters are code?" for shipped source. They keep
 * the same control flow and the same conservative regex-versus-division rule. The kill fixture in
 * `effect-ledger.test.ts` asserts what this file answers and what the real parse answers on the
 * same input.
 *
 * The file exports no `ModuleLexer`. The two halves are exported separately and neither has the
 * port type, so a test must assemble the retired lexer by name. A test pins that no shipped module
 * imports this file. Do not fix bugs in this file: its value is that it is wrong in the same way as
 * the retired code.
 */

/** One import/export specifier occurrence, as the retired walk reported it. */
export interface SupersededImportRef {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const isIdentChar = (c: string | undefined): boolean => c !== undefined && IDENT_CHAR.test(c);
const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/**
 * The retired `extractImports`: a character walk that knows comments, strings and regexes. Its
 * header claimed two properties, and the kill fixture asserts a counterexample to each:
 *
 * - At the head of a real regex literal, the walk reads `/` as division. A backtick in that regex
 *   then opens a template that is not line-bounded, so it runs to EOF and hides every later import.
 * - The walk ends `'` and `"` strings at a newline to limit a desync to one line. Template literals
 *   are exempt, and that is where the limit fails.
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
  let lastSignificant = '';
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

    if (!isIdentChar(source[i - 1])) {
      const isImport = source.startsWith('import', i) && !isIdentChar(source[i + 6]);
      const isExport = source.startsWith('export', i) && !isIdentChar(source[i + 6]);
      if (isImport || isExport) {
        pendingTypeOnly = false;
        let p = i + 'import'.length;
        while (isSpace(source[p])) p += 1;
        if (source.startsWith('type', p) && !isIdentChar(source[p + 4])) pendingTypeOnly = true;

        if (isImport) {
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
 * The retired `maskNonCode`: a near-duplicate of the walk above that blanked strings, templates,
 * comments and regex literals. Its header claimed that it masks a template literal whole, with any
 * `${…}` interpolation. That is false. Every backtick toggles the state, so the walk reads the body
 * of a template nested in a substitution as code.
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
