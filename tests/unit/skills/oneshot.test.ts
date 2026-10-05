// Structural tests for the oneshot skill. They read the authored source
// `content/delivery/skills/oneshot/SKILL.md`, not a rendered runtime variant.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillPath as resolveSkillPath } from '../../../tools/test-helpers/content-tree.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsSrcDir = resolve(__dirname, '../../../content');
const skillPath = resolveSkillPath('oneshot');

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

interface ParsedSkill {
  frontmatter: string;
  body: string;
  fields: Record<string, string>;
}

/**
 * Splits the frontmatter from the body. A line regex reads the top-level `key: value` pairs, so
 * the test needs no YAML library.
 */
function parseSkill(raw: string): ParsedSkill {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error('SKILL.md does not have a YAML frontmatter block');
  }
  const frontmatter = match[1];
  const body = match[2];

  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m) {
      fields[m[1]] = m[2].trim();
    }
  }

  return { frontmatter, body, fields };
}

describe('oneshot skill — frontmatter', () => {
  it('oneshotSkill_hasValidFrontmatter', () => {
    const raw = readSkill();
    const parsed = parseSkill(raw);
    expect(parsed.fields.name).toBeDefined();
    expect(parsed.fields.name).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(parsed.fields.name).toBe('oneshot');
  });

  /** The length check ignores one quote character at each end of the value. */
  it('oneshotSkill_descriptionIsPresentAndUnder1024Chars', () => {
    const raw = readSkill();
    const parsed = parseSkill(raw);
    const description = parsed.fields.description ?? '';
    expect(description.length).toBeGreaterThan(0);
    const stripped = description.replace(/^["']/, '').replace(/["']$/, '');
    expect(stripped.length).toBeLessThanOrEqual(1024);
  });

  it('oneshotSkill_metadataIncludesMcpServerExarchos', () => {
    const raw = readSkill();
    const parsed = parseSkill(raw);
    expect(parsed.frontmatter).toMatch(/mcp-server:\s*exarchos/);
  });
});

describe('oneshot skill — body content invariants', () => {
  /** The four lifecycle phases are `plan`, `implementing`, `synthesize` and `completed`. */
  it('oneshotSkill_bodyDocumentsAllFourPhases', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    expect(body).toMatch(/\bplan\b/i);
    expect(body).toMatch(/\bimplementing\b/i);
    expect(body).toMatch(/\bsynthesize\b/i);
    expect(body).toMatch(/\bcompleted\b/i);
  });

  /** The body names the three `synthesisPolicy` values, one of which the agent passes at init. */
  it('oneshotSkill_bodyDocumentsSynthesisPolicy', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    expect(body).toContain('always');
    expect(body).toContain('never');
    expect(body).toContain('on-request');
    expect(body).toMatch(/synthesisPolicy/);
  });

  /** `request_synthesize` is the action that opts in to synthesis during `implementing`. */
  it('oneshotSkill_bodyReferencesRequestSynthesizeAction', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    expect(body).toContain('request_synthesize');
  });

  /** `finalize_oneshot` is the action that resolves the choice state. */
  it('oneshotSkill_bodyReferencesFinalizeOneshotAction', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    expect(body).toContain('finalize_oneshot');
  });

  it('oneshotSkill_bodyMentionsTddIronLaw', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    expect(body).toMatch(/TDD|test.first|failing test/i);
  });

  it('oneshotSkill_bodyDescribesWhenNotToUseOneshot', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    expect(body).toMatch(/when not to use|don't use|do not use|not for/i);
  });

  it('oneshotSkill_bodyReferencesOneshotWorkflowType', () => {
    const raw = readSkill();
    const { body } = parseSkill(raw);
    expect(body).toMatch(/workflowType.*oneshot/);
  });
});

describe('oneshot skill — slash command wrapper', () => {
  const commandPath = resolve(
    __dirname,
    '../../../rendered/commands/oneshot.md');

  it('oneshotCommand_existsAndHasFrontmatter', () => {
    const raw = readFileSync(commandPath, 'utf-8');
    expect(raw).toMatch(/^---\n[\s\S]*?\n---\n/);
  });

  it('oneshotCommand_referencesOneshotSkill', () => {
    const raw = readFileSync(commandPath, 'utf-8');
    expect(raw).toMatch(/@skills\/oneshot\/SKILL\.md/);
  });
});
