// Source views: code, comments and string literals.
//
// Each detector in this directory must know if a token is in executable code,
// in a comment or in a string literal. A search of the raw text cannot tell the
// three apart. Then a shape matcher matches a description of the shape in a
// comment.
//
// `sourceViews()` makes one pass and returns three strings of the same length
// as the input. Each string keeps one category and blanks the other two.
// Newlines stay. Thus an offset in one view is valid in the other views.
//
// This module is a lexer, not a TypeScript parser. `LIMITATIONS.md` states its
// limits.

/** A `/` that comes after one of these characters can start a regex literal. */
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
  /** Executable code. Comments and the bodies of string, template and regex literals are blank. */
  readonly code: string;
  /** Comment text only. */
  readonly comments: string;
  /** The bodies of string, template and regex literals only. */
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

/**
 * Puts each character of `src` in the code, comment or string category.
 * The delimiters of a literal stay code, so an empty literal stays visible in
 * the code view.
 */
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
      mark(i + 1, j, 'string');
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
 * Returns the code with the bodies of string literals kept and the comments
 * blank. A rule whose subject is a string needs this view. Examples are a
 * module specifier in a `vi.mock(...)` call and the verdict value `'could-not-run'`.
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

/** Returns the 1-based line number of a character offset. */
export function lineOf(src: string, offset: number): number {
  let line = 1;
  const stop = Math.min(offset, src.length);
  for (let i = 0; i < stop; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}
