// ─── Source views: code vs. comments vs. string literals ────────────────────
//
// Every detector in this directory needs to distinguish "this token appears in
// the executable code" from "this token appears in a comment" from "this token
// appears inside a string literal". Grepping the raw text conflates all three,
// which is exactly how a shape matcher ends up matching a *description* of the
// shape in a docblock instead of the shape itself — and how the meta-test
// would quietly become the thing it exists to catch.
//
// `sourceViews()` runs ONE pass and returns three strings of EXACTLY the same
// length as the input, each with the other two categories blanked out
// (newlines always preserved). Offsets therefore agree across all views, so a
// match found in one can be located in the others.
//
// This is a lexer, not a parser. It does not need to be a full TypeScript
// tokenizer: it needs to be conservative and deterministic. Its limits are
// stated in `LIMITATIONS.md`.

/** Characters that may legally precede a regex literal (vs. a division op). */
const REGEX_PRECEDERS = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '\n',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

export interface SourceViews {
  /** Executable code; comments and string/template/regex bodies blanked. */
  readonly code: string;
  /** Comment text only; code and string bodies blanked. */
  readonly comments: string;
  /** String / template literal bodies only; everything else blanked. */
  readonly strings: string;
}

type Category = 'code' | 'comment' | 'string';

function lastMeaningfulCategoryChar(src: string, cat: Category[], upto: number): string {
  for (let i = upto - 1; i >= 0; i -= 1) {
    if (cat[i] !== 'code') continue;
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') continue;
    return c;
  }
  return '\n';
}

/** Classify every character of `src` as code / comment / string. */
export function classify(src: string): Category[] {
  const cat: Category[] = new Array<Category>(src.length).fill('code');
  const mark = (from: number, to: number, c: Category): void => {
    for (let i = Math.max(0, from); i < Math.min(to, src.length); i += 1) cat[i] = c;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j += 1;
      mark(i, j, 'comment');
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      j = Math.min(src.length, j + 2);
      mark(i, j, 'comment');
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c || src[j] === '\n') break;
        j += 1;
      }
      mark(i + 1, j, 'string'); // quotes stay 'code' so `''` is still visible
      i = Math.min(src.length, j + 1);
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          depth += 1;
          j += 2;
          continue;
        }
        if (depth > 0 && src[j] === '}') {
          depth -= 1;
          j += 1;
          continue;
        }
        if (depth === 0 && src[j] === '`') break;
        j += 1;
      }
      mark(i + 1, j, 'string');
      i = Math.min(src.length, j + 1);
      continue;
    }
    if (c === '/') {
      const prev = lastMeaningfulCategoryChar(src, cat, i);
      if (REGEX_PRECEDERS.has(prev)) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < src.length && src[j] !== '\n') {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) {
            closed = true;
            break;
          }
          j += 1;
        }
        if (closed) {
          mark(i + 1, j, 'string');
          i = j + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  return cat;
}

function project(src: string, cat: readonly Category[], keep: Category): string {
  const out: string[] = new Array<string>(src.length);
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    out[i] = cat[i] === keep ? ch : ch === '\n' ? '\n' : ' ';
  }
  return out.join('');
}

export function sourceViews(src: string): SourceViews {
  const cat = classify(src);
  return {
    code: project(src, cat, 'code'),
    comments: project(src, cat, 'comment'),
    strings: project(src, cat, 'string'),
  };
}

/**
 * Code with string-literal BODIES restored, comments still blanked. Needed by
 * any rule whose subject is itself a string — a module specifier in a
 * `vi.mock(...)` call, or a verdict value like `'could-not-run'` — because the
 * plain code view blanks exactly those characters.
 */
export function codeAndStrings(src: string): string {
  const cat = classify(src);
  const out: string[] = new Array<string>(src.length);
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    out[i] = cat[i] === 'comment' ? (ch === '\n' ? '\n' : ' ') : ch;
  }
  return out.join('');
}

/** 1-based line number of a character offset. */
export function lineOf(src: string, offset: number): number {
  let line = 1;
  const stop = Math.min(offset, src.length);
  for (let i = 0; i < stop; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}
