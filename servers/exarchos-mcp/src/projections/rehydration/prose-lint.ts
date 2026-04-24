/**
 * T048 — Prose lint on document template (DR-13).
 *
 * Scans the rehydration document's prose surface for AI-writing patterns
 * cataloged by the `humanize` skill. The goal is not stylistic policing;
 * it is to keep the template feeling human-written so agents do not learn
 * to mirror AI-slop back through rehydration payloads.
 *
 * The implemented set is a deliberately small, high-signal subset of the
 * 24 patterns documented at `~/.claude/skills/humanize/references/ai-
 * writing-patterns.md`. Low-signal or stylistically ambiguous patterns
 * (e.g. boldface overuse, title case, generic conclusions) are out of
 * scope for an automated lint.
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

// ─── Pattern catalog ───────────────────────────────────────────────────────
//
// Each entry is a regex plus a stable name. Word-boundary regexes keep
// false positives low (e.g. we want `delve` but not `delved` as part of a
// proper noun). Case-insensitive matching covers sentence-initial forms.

interface PatternDef {
  readonly name: string;
  readonly regex: RegExp;
  /**
   * If set, a violation is only emitted when the pattern fires at least
   * `minHits` times on a single line. Used for the em-dash chain, which
   * only becomes an AI tell when sustained.
   */
  readonly minHits?: number;
}

const PATTERNS: readonly PatternDef[] = [
  // AI vocabulary (category: ai-vocabulary) — high-frequency tells from
  // post-2023 LLM output.
  { name: 'ai-vocabulary:delve', regex: /\bdelve(?:s|d|ing)?\b/giu },
  { name: 'ai-vocabulary:tapestry', regex: /\btapestry\b/giu },
  { name: 'ai-vocabulary:leverage', regex: /\bleverag(?:e|es|ed|ing)\b/giu },
  // Intentionally not flagged: `underscore` (used as variable-name char in
  // code comments nearby), `highlight` (appears in legitimate UI copy).
  { name: 'ai-vocabulary:intricate', regex: /\bintricate(?:ly|ness)?\b/giu },

  // Conjunction overuse (category: conjunction-overuse) — discourse
  // markers that LLMs bolt into sentences as fake-depth connectors. We
  // match the word with a trailing comma/period because that is the
  // signature usage ("Moreover,", "furthermore."); bare occurrences in
  // code identifiers would miss the punctuation and avoid false
  // positives.
  {
    name: 'conjunction-overuse:moreover',
    regex: /\bmoreover\b\s*[,.]/giu,
  },
  { name: 'conjunction-overuse:furthermore', regex: /\bfurthermore\b\s*[,.]/giu },

  // Clichés (category: cliche) — multi-word AI tells.
  {
    name: 'cliche:navigate-complexities',
    regex: /\bnavigate\s+(?:the|these|those)?\s*(?:complex\w+|intricac\w+)\b/giu,
  },
  {
    name: 'cliche:rich-tapestry',
    regex: /\brich\s+tapestry\b/giu,
  },

  // Closers (category: closer) — canned wrap-up phrases.
  {
    name: 'closer:in-conclusion',
    regex: /(^|[.!?]\s+|\n\s*)in\s+conclusion\b[,.]/giu,
  },

  // Em-dash chain (category: em-dash-chain) — >= 3 em dashes on one line
  // is a strong signal; 1-2 is punctuation.
  { name: 'em-dash-chain', regex: /—/gu, minHits: 3 },
];

// ─── Core lint ─────────────────────────────────────────────────────────────

function truncate(s: string, max = 80): string {
  const collapsed = s.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Lint an arbitrary string of prose. Returns every violation found, with
 * per-line granularity. The return value is an empty array for clean
 * input, which is the shape `lintTemplate()` asserts on in CI.
 */
export function lintProse(text: string): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split(/\r?\n/u);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    for (const pattern of PATTERNS) {
      // Reset per-line; regexes are declared with /g so `exec` is stateful.
      const rx = new RegExp(pattern.regex.source, pattern.regex.flags);
      const hits: RegExpExecArray[] = [];
      let match: RegExpExecArray | null;
      while ((match = rx.exec(line)) !== null) {
        hits.push(match);
        if (match.index === rx.lastIndex) rx.lastIndex++;
      }

      const threshold = pattern.minHits ?? 1;
      if (hits.length < threshold) continue;

      // For chain-style patterns emit a single violation per line; for
      // everything else emit one per hit so callers can count precisely.
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

// ─── Template discovery ────────────────────────────────────────────────────
//
// `lintTemplate()` gathers every human-authored prose string that flows
// into the rehydration document's `behavioralGuidance` surface and runs
// `lintProse` over the concatenation. The inputs are:
//
//   1. The doc comments and description fields inside `schema.ts` (the
//      file that defines the template shape).
//   2. The `compactGuidance` string literals inside
//      `../../workflow/playbooks.ts` — the actual prose that becomes
//      `behavioralGuidance` at assembly time.
//
// Both files are read statically as text so that the lint does not need
// to load or execute the playbook registry. This keeps the CI hook fast
// and dependency-free.

function readSibling(relativeUrl: string): string {
  const fileUrl = new URL(relativeUrl, import.meta.url);
  return readFileSync(fileURLToPath(fileUrl), 'utf8');
}

function extractCompactGuidanceStrings(source: string): string[] {
  // Match `compactGuidance:` followed by either a single- or double-quoted
  // string (possibly multi-line via string concatenation). The playbooks
  // file currently uses single-quoted one-liners; we also support the
  // double-quoted form for forward compatibility.
  const out: string[] = [];
  const rx = /compactGuidance:\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/gu;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(source)) !== null) {
    const raw = match[2] ?? '';
    // Unescape the common cases: \' \" \\ \n. We do not evaluate the
    // string as JS — just decode escapes so the lint sees the actual
    // prose.
    const unescaped = raw
      .replace(/\\'/gu, "'")
      .replace(/\\"/gu, '"')
      .replace(/\\n/gu, '\n')
      .replace(/\\\\/gu, '\\');
    out.push(unescaped);
  }
  return out;
}

function extractDocComments(source: string): string {
  // Grab contents of every /** ... */ block. We keep the block bodies
  // verbatim so line numbers in violations still roughly point at the
  // source line.
  const out: string[] = [];
  const rx = /\/\*\*([\s\S]*?)\*\//gu;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(source)) !== null) {
    out.push(m[1] ?? '');
  }
  return out.join('\n');
}

export function lintTemplate(): Violation[] {
  const schemaSrc = readSibling('./schema.ts');
  const playbooksSrc = readSibling('../../workflow/playbooks.ts');

  const guidanceStrings = extractCompactGuidanceStrings(playbooksSrc);
  const schemaDocs = extractDocComments(schemaSrc);

  const combined = [schemaDocs, ...guidanceStrings].join('\n\n');
  return lintProse(combined);
}
