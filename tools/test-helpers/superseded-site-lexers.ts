/**
 * Three retired site lexers, kept only so that the gap to the real parse can be measured:
 *
 * - `architecture/vcs-ownership.stripComments`
 * - `workflow/admission/remediation-purity.extractImportSpecifiers`
 * - `architecture/delivery-safety.maskLiteralsAndComments`
 *
 * Each copy is verbatim. Each kill fixture asserts what a copy answers and what the real parse
 * answers on the same input. This pins the size and the direction of each defect in the tree.
 *
 * Nothing here is typed as the port of a site, so a census runs on a retired walk only by a
 * deliberate act. A test pins that no shipped module imports this file.
 *
 * Do not fix bugs in this file. Its value is that it is wrong in the same way as the retired code.
 */

/**
 * The retired `architecture/vcs-ownership.stripComments`. It strips `//` and block comments and
 * keeps string and template content.
 *
 * After an identifier character, a `)` or a `]`, it reads `/` as division. So it misses a regex
 * after a keyword such as `return`, and a backtick inside that regex opens a phantom template.
 * A template is not line-bounded, so every later `//` reads as string body. The detector then
 * charges a module with a `git worktree add` that only its documentation performs.
 */
export function supersededStripComments(source: string): string {
  let out = '';
  const n = source.length;
  let i = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  let lastSignificant = '';

  const startsRegex = (): boolean =>
    lastSignificant === '' || !/[A-Za-z0-9_$)\]]/.test(lastSignificant);

  while (i < n) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
        out += ch;
      }
      i += 1;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 2;
        continue;
      }
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }
    if (regex) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < n) out += source[i + 1] ?? '';
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
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      if (ch === '\\') {
        if (i + 1 < n) out += source[i + 1] ?? '';
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
      out += ch;
      lastSignificant = ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      lastSignificant = ch;
      i += 1;
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return out;
}

const IDENT = /[A-Za-z0-9_$]/;
const isIdent = (c: string | undefined): boolean => c !== undefined && IDENT.test(c);
const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/**
 * The retired `workflow/admission/remediation-purity.extractImportSpecifiers`. It extracts each
 * value-import specifier at code position, and skips comments and strings.
 *
 * It has no regex-literal state, so it is wrong in both directions. It also counts
 * `import('p').T` type queries as value imports.
 */
export function supersededExtractImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const n = source.length;
  let i = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
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
        pendingTypeOnly = false;
        let p = i + 'import'.length;
        while (isWs(source[p])) p += 1;
        if (source.startsWith('type', p) && !isIdent(source[p + 4])) pendingTypeOnly = true;

        if (isImport) {
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
 * The retired `architecture/delivery-safety.maskLiteralsAndComments`. It blanks each string,
 * template and comment span, so structural matching sees only real code.
 *
 * It has no regex-literal state, so a regex that holds a quote or a backtick desyncs it. It masks
 * a template literal whole, which unmasks the body of a template nested inside a `${…}`
 * substitution. For a silent-swallow gate, it invents a `catch {}` that is only template text,
 * and it misses a real one.
 */
export function supersededMaskLiteralsAndComments(source: string): string {
  const out: string[] = [];
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
        out.push('\n');
      } else {
        out.push(' ');
      }
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        out.push('  ');
        i += 1;
      } else {
        out.push(ch === '\n' ? '\n' : ' ');
      }
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        out.push('  ');
        i += 1;
      } else if (ch === quote) {
        quote = null;
        out.push(' ');
      } else {
        out.push(ch === '\n' ? '\n' : ' ');
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      out.push('  ');
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      out.push('  ');
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out.push(' ');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}
