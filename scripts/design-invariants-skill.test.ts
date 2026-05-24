// Structure tests for the repo-scoped `.claude/skills/design-invariants/`
// skill. Asserts shape — frontmatter validity, reference-file presence,
// no-frontmatter-on-references, internal cross-link integrity, and
// deterministic-checks coverage. Content quality is out of scope; this
// file only enforces invariants that a future generator (#1260) will
// also rely on.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(REPO_ROOT, '.claude', 'skills', 'design-invariants');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');
const REFERENCES_DIR = path.join(SKILL_DIR, 'references');

// Stable invariant ID set — must match the discovery report
// (`docs/research/2026-05-07-design-invariants-skill.md` §3) and the
// frontmatter description verbatim.
const INVARIANT_IDS = [
  'INV-1',
  'INV-2',
  'INV-3',
  'INV-4',
  'INV-5a',
  'INV-5b',
  'INV-5c',
  'INV-5d',
  'INV-6',
] as const;

// Invariants that MUST carry at least one deterministic grep/structural
// check per the discovery report §6 question 5. The remaining invariants
// (INV-3, INV-5a, INV-5b, INV-5c) are reasoning-driven; their checks live
// in the reference files themselves rather than as grep patterns.
const INVARIANTS_REQUIRING_DETERMINISTIC_CHECKS = [
  'INV-1',
  'INV-2',
  'INV-4',
  'INV-5d',
  'INV-6',
] as const;

interface Frontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
}

function readFrontmatter(file: string): Frontmatter | null {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const block = match[1];
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let metadataBuf: Record<string, unknown> | null = null;
  for (const rawLine of block.split('\n')) {
    const indent = rawLine.match(/^(\s*)/)?.[1].length ?? 0;
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (indent === 0) {
      const kv = trimmed.match(/^([a-zA-Z_-]+):\s*(.*)$/);
      if (!kv) continue;
      const [, key, val] = kv;
      currentKey = key;
      if (val === '') {
        if (key === 'metadata') {
          metadataBuf = {};
          result.metadata = metadataBuf;
        }
      } else {
        result[key] = val.replace(/^"(.*)"$/, '$1');
      }
    } else if (currentKey === 'metadata' && metadataBuf) {
      const kv = trimmed.match(/^([a-zA-Z_-]+):\s*(.*)$/);
      if (!kv) continue;
      metadataBuf[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return result as Frontmatter;
}

describe('design-invariants skill structure', () => {
  it('Skill_HasValidFrontmatter', () => {
    expect(fs.existsSync(SKILL_FILE)).toBe(true);
    const fm = readFrontmatter(SKILL_FILE);
    expect(fm).not.toBeNull();
    expect(fm?.name).toBe('design-invariants');
    expect(typeof fm?.description).toBe('string');
    expect((fm?.description ?? '').length).toBeGreaterThan(0);
    expect(fm?.metadata).toBeDefined();
    // Post-v2 (#1459 Wave E1): pairs-with slot changed from axiom:backend-quality
    // → axiom:design per D5 §4.3 + the axiom pairing-discovery contract
    // (axiom's contract scans the `pairs-with` slot for `axiom:design`, not the
    // older backend-quality slot). The catalog v2 entries carry axiom_overlap:
    // DIM-N fields that axiom:design interleaves during /ideate Phase 0.
    expect((fm?.metadata as Record<string, unknown> | undefined)?.['pairs-with']).toBe(
      'axiom:design',
    );
  });

  it('ReferenceFiles_AllInvariantsPresent', () => {
    expect(fs.existsSync(REFERENCES_DIR)).toBe(true);
    for (const id of INVARIANT_IDS) {
      const matches = fs
        .readdirSync(REFERENCES_DIR)
        .filter((f) => f.startsWith(`${id}-`) && f.endsWith('.md'));
      expect(matches.length, `expected reference file starting with ${id}-`).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('ReferenceFiles_NoYAMLFrontmatter', () => {
    // Per CLAUDE.md "Reference-file frontmatter" rule: reference files
    // are includes, not skill entry points; YAML frontmatter is reserved
    // for SKILL.md / commands / rules.
    const refFiles = fs
      .readdirSync(REFERENCES_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(REFERENCES_DIR, f));
    expect(refFiles.length).toBeGreaterThan(0);
    for (const file of refFiles) {
      const text = fs.readFileSync(file, 'utf8');
      // A reference file MUST NOT start with `---\n` (frontmatter open).
      // The check is positional — we don't reject `---` anywhere in the
      // body, only as the first three characters.
      expect(text.startsWith('---\n'), `frontmatter found in ${path.basename(file)}`).toBe(false);
    }
  });

  it('Skill_LinksAllInvariantReferences', () => {
    const skillBody = fs.readFileSync(SKILL_FILE, 'utf8');
    for (const id of INVARIANT_IDS) {
      // The skill body must contain a reference link of the form
      // `references/<id>-...md`. Testing for the prefix lets the
      // file-name suffix vary per invariant.
      const linkPattern = new RegExp(`references/${id}-[a-z0-9-]+\\.md`);
      expect(linkPattern.test(skillBody), `SKILL.md missing link to ${id}`).toBe(true);
    }
  });

  it('Skill_DescriptionMentionsINV-6', () => {
    const fm = readFrontmatter(SKILL_FILE);
    expect(fm).not.toBeNull();
    const description = fm?.description ?? '';
    expect(
      description.includes('INV-6'),
      'SKILL.md frontmatter description must enumerate INV-6 alongside INV-1..INV-5d',
    ).toBe(true);
    const skillBody = fs.readFileSync(SKILL_FILE, 'utf8');
    // Body must contain a walk section for INV-6 (header form: `## INV-6 ...`)
    expect(
      /^##\s+INV-6\b/m.test(skillBody),
      'SKILL.md body must contain a `## INV-6` walk section',
    ).toBe(true);
  });

  it('ComplementarityMatrix_HasINV-6Row', () => {
    const text = fs.readFileSync(SKILL_FILE, 'utf8');
    // The complementarity matrix is a markdown table with three columns
    // (Finding | Axiom dimension | Design invariant). At least one row
    // must place INV-6 in the "Design invariant" column. Match a table
    // row line that contains `INV-6` between pipes.
    const rowPattern = /^\|[^\n]*\|[^\n]*\|[^\n]*INV-6[^\n]*\|/m;
    expect(
      rowPattern.test(text),
      'complementarity matrix must include at least one row with INV-6 in the Design invariant column',
    ).toBe(true);
  });

  it('DeterministicChecks_CoverRequiredInvariants', () => {
    const checksFile = path.join(REFERENCES_DIR, 'deterministic-checks.md');
    expect(fs.existsSync(checksFile)).toBe(true);
    const text = fs.readFileSync(checksFile, 'utf8');
    for (const id of INVARIANTS_REQUIRING_DETERMINISTIC_CHECKS) {
      // Each required invariant must be referenced by ID in a section
      // header or paragraph, AND the file must contain at least one
      // fenced code block with a grep/rg/find pattern.
      expect(text.includes(id), `deterministic-checks missing ${id} section`).toBe(true);
    }
    // At least four fenced code blocks (one per required invariant) —
    // a permissive lower bound; reality will be higher.
    const codeBlocks = text.match(/```[a-z]*\n[\s\S]*?\n```/g) ?? [];
    expect(codeBlocks.length).toBeGreaterThanOrEqual(4);
  });
});
