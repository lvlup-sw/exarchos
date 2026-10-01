/**
 * Prose lint for the rehydration document template.
 *
 * It scans the template prose for AI-writing patterns from the `humanize` skill, so that agents do not learn to copy them.
 * It checks a small, high-signal subset of those patterns. Ambiguous patterns, for example title case, are out of scope.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Violation {
  /** Stable pattern identifier. Format: `<category>:<name>`. */
  readonly pattern: string;
  /** 1-indexed line number within the linted input. */
  readonly line: number;
  /** The offending text fragment (trimmed to ~80 chars). */
  readonly excerpt: string;
}

/**
 * One lint pattern: a stable name and a regex.
 * The word regexes use word boundaries to keep false positives low. The `i` flag matches sentence-initial forms.
 */
interface PatternDef {
  readonly name: string;
  readonly regex: RegExp;
  /** When set, the pattern must match at least `minHits` times on one line. The em-dash chain uses it. */
  readonly minHits?: number;
}

/**
 * The pattern catalog. It does not flag `underscore` or `highlight`, because code comments and UI copy use them legitimately.
 */
const PATTERNS: readonly PatternDef[] = [
  /** AI vocabulary: high-frequency words of LLM output. */
  { name: 'ai-vocabulary:delve', regex: /\bdelve(?:s|d|ing)?\b/giu },
  { name: 'ai-vocabulary:tapestry', regex: /\btapestry\b/giu },
  { name: 'ai-vocabulary:leverage', regex: /\bleverag(?:e|es|ed|ing)\b/giu },
  { name: 'ai-vocabulary:intricate', regex: /\bintricate(?:ly|ness)?\b/giu },

  /**
   * Conjunction overuse. The regex needs a trailing comma or period, so a code identifier does not match.
   */
  {
    name: 'conjunction-overuse:moreover',
    regex: /\bmoreover\b\s*[,.]/giu,
  },
  { name: 'conjunction-overuse:furthermore', regex: /\bfurthermore\b\s*[,.]/giu },

  /** Multi-word clichés. */
  {
    name: 'cliche:navigate-complexities',
    regex: /\bnavigate\s+(?:the|these|those)?\s*(?:complex\w+|intricac\w+)\b/giu,
  },
  {
    name: 'cliche:rich-tapestry',
    regex: /\brich\s+tapestry\b/giu,
  },

  /** Canned closing phrase. */
  {
    name: 'closer:in-conclusion',
    regex: /(^|[.!?]\s+|\n\s*)in\s+conclusion\b[,.]/giu,
  },

  /** Em-dash chain: three or more em dashes on one line. One or two are normal punctuation. */
  { name: 'em-dash-chain', regex: /—/gu, minHits: 3 },
];

function truncate(s: string, max = 80): string {
  const collapsed = s.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Lints a string of prose line by line, and returns an empty array for clean input.
 * Each line gets a new copy of each regex, because `exec` on a `/g` regex keeps state.
 * A pattern with `minHits` gives one violation for each line. Other patterns give one violation for each hit.
 */
export function lintProse(text: string): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split(/\r?\n/u);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    for (const pattern of PATTERNS) {
      const rx = new RegExp(pattern.regex.source, pattern.regex.flags);
      const hits: RegExpExecArray[] = [];
      let match: RegExpExecArray | null;
      while ((match = rx.exec(line)) !== null) {
        hits.push(match);
        if (match.index === rx.lastIndex) rx.lastIndex++;
      }

      const threshold = pattern.minHits ?? 1;
      if (hits.length < threshold) continue;

      if (pattern.minHits !== undefined) {
        violations.push({
          pattern: pattern.name,
          line: lineNo,
          excerpt: truncate(line),
        });
      } else {
        for (const hit of hits) {
          violations.push({
            pattern: pattern.name,
            line: lineNo,
            excerpt: truncate(hit[0]),
          });
        }
      }
    }
  }

  return violations;
}

function readSibling(relativeUrl: string): string {
  const fileUrl = new URL(relativeUrl, import.meta.url);
  return readFileSync(fileURLToPath(fileUrl), 'utf8');
}

/**
 * Returns each single- or double-quoted string after `compactGuidance:` in `source`.
 * It decodes the escapes for quotes, newline and backslash, and does not evaluate the string as JS.
 */
function extractCompactGuidanceStrings(source: string): string[] {
  const out: string[] = [];
  const rx = /compactGuidance:\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/gu;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(source)) !== null) {
    const raw = match[2] ?? '';
    const unescaped = raw
      .replace(/\\'/gu, "'")
      .replace(/\\"/gu, '"')
      .replace(/\\n/gu, '\n')
      .replace(/\\\\/gu, '\\');
    out.push(unescaped);
  }
  return out;
}

/** Returns the body of each JSDoc block in `source`, joined by newlines. */
function extractDocComments(source: string): string {
  const out: string[] = [];
  const rx = /\/\*\*([\s\S]*?)\*\//gu;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(source)) !== null) {
    out.push(m[1] ?? '');
  }
  return out.join('\n');
}

/**
 * Lints the prose that flows into `phasePlaybook.compactGuidance` of the rehydration document.
 * The inputs are the doc comments of `schema.ts` and the `compactGuidance` string literals of `workflow/playbooks.ts`.
 * It reads both files as text, so it does not load the playbook registry.
 */
export function lintTemplate(): Violation[] {
  const schemaSrc = readSibling('./schema.ts');
  const playbooksSrc = readSibling('../../workflow/playbooks.ts');

  const guidanceStrings = extractCompactGuidanceStrings(playbooksSrc);
  const schemaDocs = extractDocComments(schemaSrc);

  const combined = [schemaDocs, ...guidanceStrings].join('\n\n');
  return lintProse(combined);
}
