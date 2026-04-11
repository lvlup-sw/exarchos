// ─── Oneshot workflow skill structural tests (T14) ──────────────────────────
//
// These tests assert structural and frontmatter invariants of the canonical
// `skills-src/oneshot-workflow/SKILL.md` source — NOT the generated runtime
// variants under `skills/<runtime>/`. Per CLAUDE.md, source-of-truth for
// skills lives in `skills-src/`; the renderer (T19) produces byte-identical
// per-runtime copies of the body, so semantic invariants only need to be
// checked once on the source.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsSrcDir = resolve(__dirname, '../../../../../skills-src');
const skillPath = resolve(skillsSrcDir, 'oneshot-workflow/SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

interface ParsedSkill {
  frontmatter: string;
  body: string;
  fields: Record<string, string>;
}

function parseSkill(raw: string): ParsedSkill {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error('SKILL.md does not have a YAML frontmatter block');
  }
  const frontmatter = match[1];
  const body = match[2];

  // Crude key: value extraction for top-level keys (sufficient for the
  // assertions we need — we explicitly do NOT want to depend on a YAML
  // library here for a tiny structural sniff).
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m) {
      fields[m[1]] = m[2].trim();
    }
  }

  return { frontmatter, body, fields };
}

describe('oneshot-workflow skill — frontmatter', () => {
  it('oneshotSkill_hasValidFrontmatter', () => {
    const raw = readSkill();
    const parsed = parseSkill(raw);
    expect(parsed.fields.name).toBeDefined();
    // kebab-case
    expect(parsed.fields.name).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(parsed.fields.name).toBe('oneshot-workflow');
  });

  it('oneshotSkill_descriptionIsPresentAndUnder1024Chars', () => {
    const raw = readSkill();
    const parsed = parseSkill(raw);
    const description = parsed.fields.description ?? '';
    expect(description.length).toBeGreaterThan(0);
    // Strip surrounding quotes if present for the length check
    const stripped = description.replace(/^["']/, '').replace(/["']$/, '');
    expect(stripped.length).toBeLessThanOrEqual(1024);
  });

  it('oneshotSkill_metadataIncludesMcpServerExarchos', () => {
    const raw = readSkill();
    const parsed = parseSkill(raw);
    // metadata block contains `mcp-server: exarchos` line
    expect(parsed.frontmatter).toMatch(/mcp-server:\s*exarchos/);
  });
});

describe('oneshot-workflow skill — body content invariants', () => {
  it('oneshotSkill_bodyDocumentsAllFourPhases', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    // The four lifecycle phases: plan, implementing, synthesize (opt-in only),
    // and completed (terminal). Skill prose must walk the agent through each.
    expect(body).toMatch(/\bplan\b/i);
    expect(body).toMatch(/\bimplementing\b/i);
    expect(body).toMatch(/\bsynthesize\b/i);
    expect(body).toMatch(/\bcompleted\b/i);
  });

  it('oneshotSkill_bodyDocumentsSynthesisPolicy', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    // Three valid synthesisPolicy values must be named so the agent knows
    // what to pass at init.
    expect(body).toContain('always');
    expect(body).toContain('never');
    expect(body).toContain('on-request');
    expect(body).toMatch(/synthesisPolicy/);
  });

  it('oneshotSkill_bodyReferencesRequestSynthesizeAction', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    // The mid-implementing opt-in trigger must be discoverable by name.
    expect(body).toContain('request_synthesize');
  });

  it('oneshotSkill_bodyReferencesFinalizeOneshotAction', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    // The choice-state resolver must be discoverable by name.
    expect(body).toContain('finalize_oneshot');
  });

  it('oneshotSkill_bodyMentionsTddIronLaw', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    // TDD is mandatory even for oneshot — guarded explicitly so a future
    // edit can't quietly drop it.
    expect(body).toMatch(/TDD|test.first|failing test/i);
  });

  it('oneshotSkill_bodyDescribesWhenNotToUseOneshot', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    // Must steer agents away from cross-cutting refactors / multi-file features.
    expect(body).toMatch(/when not to use|don't use|do not use|not for/i);
  });

  it('oneshotSkill_bodyReferencesOneshotWorkflowType', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    // The init call must reference workflowType: 'oneshot'.
    expect(body).toMatch(/workflowType.*oneshot/);
  });
});

describe('oneshot-workflow skill — slash command wrapper', () => {
  const commandPath = resolve(
    __dirname,
    '../../../../../commands/oneshot.md',
  );

  it('oneshotCommand_existsAndHasFrontmatter', () => {
    const raw = readFileSync(commandPath, 'utf-8');
    expect(raw).toMatch(/^---\n[\s\S]*?\n---\n/);
  });

  it('oneshotCommand_referencesOneshotSkill', () => {
    const raw = readFileSync(commandPath, 'utf-8');
    // Wrapper should point at the canonical skill so the runtime renderer
    // wires up the @skills/oneshot-workflow/SKILL.md include.
    expect(raw).toMatch(/oneshot-workflow/);
  });
});
