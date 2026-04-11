/**
 * Structural tests for the prune-workflows skill.
 *
 * Validates the skills-src/prune-workflows/SKILL.md frontmatter and body
 * against the conventions documented in CLAUDE.md and the T5 task spec
 * in docs/plans/2026-04-11-oneshot-and-pruning.md:
 *
 *   - name is kebab-case
 *   - description is <= 1024 chars
 *   - metadata.mcp-server is "exarchos" (skill invokes MCP tools)
 *   - body references the prune_stale_workflows orchestrate action
 *   - body documents both dry-run and apply phases
 *
 * Reads from skills-src/ (canonical source) per the same convention used
 * by runbooks/skill-coverage.test.ts. The generated skills/ tree is
 * verified separately by the skills-guard CI check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillPath = resolve(
  __dirname,
  '../../../../../skills-src/prune-workflows/SKILL.md',
);

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  metadata?: { 'mcp-server'?: unknown } & Record<string, unknown>;
}

function loadSkill(): { frontmatter: SkillFrontmatter; body: string; raw: string } {
  const raw = readFileSync(skillPath, 'utf-8');
  // Frontmatter must be a YAML block delimited by --- on its own lines
  // at the start of the file.
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error(`SKILL.md missing YAML frontmatter delimited by ---: ${skillPath}`);
  }
  const frontmatter = parseYaml(match[1]) as SkillFrontmatter;
  return { frontmatter, body: match[2], raw };
}

describe('prune-workflows skill', () => {
  it('pruneSkill_frontmatterHasKebabCaseName', () => {
    const { frontmatter } = loadSkill();
    expect(typeof frontmatter.name).toBe('string');
    expect(frontmatter.name).toBe('prune-workflows');
    // kebab-case: lowercase letters/digits, words joined by single hyphens.
    expect(frontmatter.name as string).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });

  it('pruneSkill_descriptionBelow1024Chars', () => {
    const { frontmatter } = loadSkill();
    expect(typeof frontmatter.description).toBe('string');
    const description = frontmatter.description as string;
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('pruneSkill_metadataHasMcpServerExarchos', () => {
    const { frontmatter } = loadSkill();
    expect(frontmatter.metadata).toBeDefined();
    expect(frontmatter.metadata?.['mcp-server']).toBe('exarchos');
  });

  it('pruneSkill_bodyReferencesPruneAction', () => {
    const { body } = loadSkill();
    // The skill must reference the orchestrate action by its registered name.
    expect(body).toContain('prune_stale_workflows');
  });

  it('pruneSkill_includesDryRunAndApplySteps', () => {
    const { body } = loadSkill();
    // Both phases of the prune flow must be documented.
    expect(body).toMatch(/dryRun:\s*true/);
    expect(body).toMatch(/dryRun:\s*false/);
  });

  it('pruneSkill_documentsForceBypassOption', () => {
    const { body } = loadSkill();
    // The user-facing safeguard bypass must be documented per design Part 1.
    expect(body).toMatch(/force/);
  });

  it('pruneSkill_documentsConfirmationPrompt', () => {
    const { body } = loadSkill();
    // The skill is interactive — it must prompt the user before applying.
    expect(body.toLowerCase()).toMatch(/proceed|confirm|abort/);
  });
});
