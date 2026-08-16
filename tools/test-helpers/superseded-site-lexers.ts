// ─── The three RETIRED site lexers, kept only so the gap can be measured ─────
//
// Task 065 replaced the effect ledger's hand-rolled walks with a real parse and
// named three survivors. Task 072 retired those three. Until then they lived in
// shipped `src/`:
//
//   • `architecture/vcs-ownership.stripComments`
//   • `workflow/admission/remediation-purity.extractImportSpecifiers`
//   • `architecture/delivery-safety.maskLiteralsAndComments`
//
// They are reproduced here VERBATIM — same control flow, same conservative
// regex-versus-division rule, same line-bounded quotes, same absence of one —
// for exactly one purpose: each site's kill fixture asserts what THIS answers
// and what the real parse answers on the same input, so the size and the
// DIRECTION of each defect is pinned in the tree rather than described in a
// commit message. A port that is never shown to differ from what it replaced has
// not been shown to be needed.
//
// Same discipline as `superseded-source-lexer.ts`, for the same reason: nothing
// here is typed as any site's port, so driving a real census through a retired
// walk takes a deliberate, named act, and a test pins that no shipped module
// imports this file. Retiring a defect and leaving it casually callable is how
// it comes back.
//
// Do not fix bugs in this file. Its value is being wrong in precisely the way
// the shipped tree used to be wrong.

// ─── 1. `architecture/vcs-ownership.stripComments` ──────────────────────────
//
// Strips `//` and block comments while preserving string/template content. Its
// own header claimed the `/`-in-operand-position rule was "deliberately
// CONSERVATIVE: when in doubt it treats `/` as division, which merely falls back
// to the old behaviour instead of swallowing real code (a false negative in a
// ratchet is the dangerous direction, so the ambiguity is resolved away from
// it)". That is false in the other direction: scoring the head of a real regex
// literal as division lets a BACKTICK inside that regex open a phantom template
// literal, and a template is not line-bounded — so every subsequent `//` reads
// as string body, comment prose survives the strip, and the detector charges a
// module with a `git worktree add` that only its documentation performs.

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

// ─── 2. `workflow/admission/remediation-purity.extractImportSpecifiers` ──────
//
// Extracts every VALUE-import specifier at code position. Its own header claimed
// it walked "comment/string-aware so a specifier inside a string literal or a
// doc comment is not mistaken for a real import", and the module's header called
// the re-implementation deliberate: "this detector deliberately re-implements
// only the minimal specifier extraction it needs". It has no regex-literal state
// at all — weaker than the two walks task 065 retired — so it is wrong in both
// directions AND miscounts `import('p').T` type queries as value imports.

const IDENT = /[A-Za-z0-9_$]/;
const isIdent = (c: string | undefined): boolean => c !== undefined && IDENT.test(c);
const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

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

// ─── 3. `architecture/delivery-safety.maskLiteralsAndComments` ───────────────
//
// Blanks every string, template and comment span so structural matching sees
// only real code. Like the walk above it has NO regex-literal state, so a regex
// holding a quote or a backtick desyncs it — and it masks a template literal
// whole, which un-masks the body of a template nested inside a `${…}`
// substitution. Both directions are live for a silent-swallow gate: it invents a
// `catch {}` that is only template text, and it misses a real one.

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
