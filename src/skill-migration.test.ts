/**
 * Tests for the VCS MCP action migration in skill templates.
 *
 * Verifies that actionable `gh` CLI commands in skills-src/ have been
 * migrated to `exarchos_orchestrate({ action: "..." })` MCP action
 * references, and that VCS provider preambles are present in affected
 * skills.
 *
 * Task T34: Migrate skill templates from `gh` to MCP action references.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_SRC_DIR = resolve(__dirname, '..', 'skills-src');

/**
 * Recursively collect all .md files in a directory.
 */
function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Patterns that indicate actionable `gh` commands that SHOULD be migrated.
 * These are patterns where the skill tells the agent to RUN the command.
 *
 * The patterns match within code blocks or inline code.
 */
const ACTIONABLE_GH_PATTERNS = [
  // gh pr create — should use create_pr action
  /(?:^|\n)\s*(?:```[\s\S]*?)?gh pr create\b/,
  // gh pr merge ... --auto --squash — should use merge_pr action
  /(?:^|\n)\s*(?:```[\s\S]*?)?gh pr merge\b/,
  // gh issue create — should use create_issue action
  /(?:^|\n)\s*(?:```[\s\S]*?)?gh issue create\b/,
  // gh pr checks — should use check_ci action
  /(?:^|\n)\s*(?:```[\s\S]*?)?gh pr checks\b/,
  // gh pr view ... --json reviews,comments — should use get_pr_comments
  /gh pr view\s+\S+\s+--json\s+(?:reviews|comments|reviews,comments)/,
  // gh pr list (non-documentation context) — should use list_prs action
  // Only flag when it appears as an actionable command (inside code blocks)
  /(?:^|\n)\s*gh pr list\b/,
  // gh pr comment — should use add_pr_comment action
  /(?:^|\n)\s*(?:```[\s\S]*?)?gh pr comment\b/,
];

/**
 * Exceptions: files or patterns that should be KEPT as gh commands.
 * These represent operations without MCP action equivalents or
 * pure documentation context.
 */
const ALLOWED_GH_REFERENCES = [
  // gh pr edit --add-label — no MCP action for labels
  /gh pr edit\s+\S+\s+--add-label/,
  // gh pr edit --base — no MCP action for PR retarget
  /gh pr edit\s+\S+\s+--base/,
  // gh pr edit --body — used for updating PR body, complex formatting
  /gh pr edit\s+\S+\s+--body/,
  // gh pr edit --add-reviewer — no MCP action for reviewer assignment
  /gh pr edit\s+\S+\s+--add-reviewer/,
  // gh pr update-branch — no MCP action for branch update
  /gh pr update-branch/,
  // gh pr diff — handled locally
  /gh pr diff/,
  // gh pr view ... --json autoMergeRequest — specific operational check
  /gh pr view\s+\S+\s+--json\s+autoMergeRequest/,
];

/**
 * Skills that use VCS operations and should have a VCS preamble.
 */
const SKILLS_REQUIRING_VCS_PREAMBLE = [
  'synthesis',
  'shepherd',
  'cleanup',
  'dogfood',
  'prune-workflows',
  'oneshot-workflow',
];

describe('skill-migration — T34: gh to MCP action migration', () => {
  /**
   * Scan all skill-src markdown files for actionable `gh pr create`,
   * `gh pr merge`, and `gh issue create` commands that should have been
   * migrated to MCP action references.
   */
  it('NoActionableGhPrCreate_InSkillSources', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Check for `gh pr create` as actionable command
        if (/\bgh pr create\b/.test(line)) {
          // Allow if it's in a migration table mapping or pure documentation
          const isAllowed =
            // Migration mapping table (Graphite equivalents, etc.)
            /\|.*gh pr create.*\|/.test(line) ||
            // Pure explanation text (not in a code block or actionable instruction)
            false;
          if (!isAllowed) {
            violations.push({
              file: file.replace(SKILLS_SRC_DIR + '/', ''),
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh pr create' references that should be migrated to exarchos_orchestrate({ action: "create_pr" }):\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  it('NoActionableGhPrMerge_InSkillSources', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh pr merge\b/.test(line)) {
          // Allow in migration mapping table
          const isAllowed = /\|.*gh pr merge.*\|/.test(line);
          if (!isAllowed) {
            violations.push({
              file: file.replace(SKILLS_SRC_DIR + '/', ''),
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh pr merge' references that should be migrated to exarchos_orchestrate({ action: "merge_pr" }):\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  it('NoActionableGhIssueCreate_InSkillSources', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh issue create\b/.test(line)) {
          violations.push({
            file: file.replace(SKILLS_SRC_DIR + '/', ''),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh issue create' references that should be migrated to exarchos_orchestrate({ action: "create_issue" }):\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  it('NoActionableGhPrChecks_InSkillSources', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh pr checks\b/.test(line)) {
          violations.push({
            file: file.replace(SKILLS_SRC_DIR + '/', ''),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh pr checks' references that should be migrated to exarchos_orchestrate({ action: "check_ci" }):\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  it('NoActionableGhPrViewJsonReviews_InSkillSources', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match gh pr view <num> --json reviews,comments or similar
        if (/\bgh pr view\s+\S+\s+--json\s+(?:reviews|comments|reviews,comments)\b/.test(line)) {
          violations.push({
            file: file.replace(SKILLS_SRC_DIR + '/', ''),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh pr view --json reviews/comments' references that should be migrated to exarchos_orchestrate({ action: "get_pr_comments" }):\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  it('NoActionableGhPrComment_InSkillSources', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh pr comment\b/.test(line)) {
          violations.push({
            file: file.replace(SKILLS_SRC_DIR + '/', ''),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh pr comment' references that should be migrated to exarchos_orchestrate({ action: "add_pr_comment" }):\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  /**
   * For gh pr list used as actionable commands (not documentation),
   * verify migration to list_prs. We exclude the Graphite mapping table
   * and gh pr list used in safeguards/prune context (kept as gh).
   */
  it('NoActionableGhPrList_InSkillSources_ExceptAllowedContexts', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    // Files that are allowed to keep gh pr list references:
    // - prune-workflows references (safeguards use gh internally)
    // - github-native-stacking.md (Graphite mapping table kept for reference)
    const ALLOWED_FILES = [
      'prune-workflows/references/safeguards.md',
      'prune-workflows/SKILL.md',
    ];

    for (const file of files) {
      const relPath = file.replace(SKILLS_SRC_DIR + '/', '');
      if (ALLOWED_FILES.some((allowed) => relPath === allowed)) continue;

      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh pr list\b/.test(line)) {
          // Allow in Graphite migration mapping table
          const isAllowed =
            /\|.*gh pr list.*\|/.test(line) ||
            // Allow "from gh pr list" in explanatory text
            /from\s+`gh pr list/.test(line);
          if (!isAllowed) {
            violations.push({
              file: relPath,
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh pr list' references that should be migrated to exarchos_orchestrate({ action: "list_prs" }):\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  it('NoActionableGhPrView_InSkillSources_ExceptAllowedOperations', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const relPath = file.replace(SKILLS_SRC_DIR + '/', '');
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh pr view\b/.test(line)) {
          // Allowed gh pr view operations (no MCP equivalent)
          const isAllowed =
            /--json\s+autoMergeRequest/.test(line) || // Auto-merge check — no MCP equiv
            /\|.*gh pr view.*\|/.test(line);          // In a table (documentation)
          if (!isAllowed) {
            violations.push({
              file: relPath,
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh pr view' references that should be migrated:\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  it('NoActionableGhIssueView_InSkillSources', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const relPath = file.replace(SKILLS_SRC_DIR + '/', '');
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh issue view\b/.test(line)) {
          violations.push({
            file: relPath,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh issue view' references that should be migrated:\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  /**
   * Verify VCS preamble is present in skills that use VCS operations.
   */
  it('VcsPreamble_PresentInAffectedSkills', () => {
    const missing: string[] = [];

    for (const skillName of SKILLS_REQUIRING_VCS_PREAMBLE) {
      const skillPath = join(SKILLS_SRC_DIR, skillName, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      const content = readFileSync(skillPath, 'utf8');
      // Check for VCS preamble section
      if (!content.includes('## VCS Provider')) {
        missing.push(skillName);
      }
    }

    expect(
      missing,
      `Skills missing VCS Provider preamble: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * Verify that MCP action references exist in skills that previously used gh commands.
   */
  it('McpActionReferences_PresentInMigratedSkills', () => {
    const synthSkillPath = join(SKILLS_SRC_DIR, 'synthesis', 'SKILL.md');
    const content = readFileSync(synthSkillPath, 'utf8');

    // Should reference create_pr and merge_pr actions
    expect(content).toContain('action: "create_pr"');
    expect(content).toContain('action: "merge_pr"');
  });

  it('McpActionReferences_ListPrs_PresentInMigratedSkills', () => {
    const synthSkillPath = join(SKILLS_SRC_DIR, 'synthesis', 'SKILL.md');
    const content = readFileSync(synthSkillPath, 'utf8');

    // Should reference list_prs action
    expect(content).toContain('action: "list_prs"');
  });

  it('McpActionReferences_CreateIssue_PresentInDogfood', () => {
    const dogfoodPath = join(SKILLS_SRC_DIR, 'dogfood', 'SKILL.md');
    const content = readFileSync(dogfoodPath, 'utf8');

    // Should reference create_issue action
    expect(content).toContain('action: "create_issue"');
  });

  it('McpActionReferences_CheckCi_PresentInTroubleshooting', () => {
    const troublePath = join(
      SKILLS_SRC_DIR,
      'synthesis',
      'references',
      'troubleshooting.md',
    );
    const content = readFileSync(troublePath, 'utf8');

    // Should reference check_ci action
    expect(content).toContain('action: "check_ci"');
  });
});
