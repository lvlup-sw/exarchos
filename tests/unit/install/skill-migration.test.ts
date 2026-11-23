/**
 * Tests that skill content stays harness-neutral for VCS writes and uses MCP actions for VCS reads.
 * A source under `content/` names no actionable `gh pr create`, `gh pr merge`, `gh pr comment` or `gh issue create`.
 * The harness of the coordinator owns these writes.
 * A source under `content/` holds no actionable `gh` read that an `exarchos_orchestrate` read action replaces.
 * A skill that uses VCS operations must hold a VCS provider preamble.
 * No Markdown source under `content/` names a retired action.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { skillPath as resolveSkillPath, skillReference as resolveSkillReference } from '../../../tools/test-helpers/content-tree.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_SRC_DIR = resolve(__dirname, '../../../content');

/** The path relative to `SKILLS_SRC_DIR`, with forward slashes on every platform, so it matches the POSIX-style allowlist entries. */
function relToSkillsSrc(file: string): string {
  return relative(SKILLS_SRC_DIR, file).split(/[\\/]/).join('/');
}

/** Collects each `.md` file below `dir`, recursively. */
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

/** Patterns for an actionable `gh` command, which is one that the skill tells the agent to run. */
const ACTIONABLE_GH_PATTERNS = [
  /** `gh pr create`. The harness of the coordinator creates each PR, so skill content names no command for it. */
  /(?:^|\n)\s*(?:```[\s\S]*?)?gh pr create\b/,
  /** `gh pr merge`. The harness of the coordinator merges each PR, so skill content names no command for it. */
  /(?:^|\n)\s*(?:```[\s\S]*?)?gh pr merge\b/,
  /** `gh issue create`. The harness of the coordinator files each issue, so skill content names no command for it. */
  /(?:^|\n)\s*(?:```[\s\S]*?)?gh issue create\b/,
  /** `gh pr checks`, which the `check_ci` action replaces. */
  /(?:^|\n)\s*(?:```[\s\S]*?)?gh pr checks\b/,
  /** `gh pr view` with `--json reviews` or `--json comments`, which the `get_pr_comments` action replaces. */
  /gh pr view\s+\S+\s+--json\s+(?:reviews|comments|reviews,comments)/,
  /** `gh pr list` at the start of a line, which the `list_prs` action replaces. */
  /(?:^|\n)\s*gh pr list\b/,
  /** `gh pr comment`. The harness of the coordinator posts each comment, so skill content names no command for it. */
  /(?:^|\n)\s*(?:```[\s\S]*?)?gh pr comment\b/,
];

/** `gh` commands that skill content can keep. Each element gives the reason. */
const ALLOWED_GH_REFERENCES = [
  /** `gh pr edit --add-label`. No MCP action sets a label. */
  /gh pr edit\s+\S+\s+--add-label/,
  /** `gh pr edit --base`. No MCP action retargets a PR. */
  /gh pr edit\s+\S+\s+--base/,
  /** `gh pr edit --body`. The update of a PR body needs complex formatting. */
  /gh pr edit\s+\S+\s+--body/,
  /** `gh pr edit --add-reviewer`. No MCP action assigns a reviewer. */
  /gh pr edit\s+\S+\s+--add-reviewer/,
  /** `gh pr update-branch`. No MCP action updates a branch. */
  /gh pr update-branch/,
  /** `gh pr diff`, which is handled locally. */
  /gh pr diff/,
  /** `gh pr view --json autoMergeRequest`, an auto-merge check with no MCP action. */
  /gh pr view\s+\S+\s+--json\s+autoMergeRequest/,
];

/** Retired action names, and the retired `merge-orchestrate` CLI verb. Each pattern matches a whole word only. */
const RETIRED_ACTION_PATTERNS = [
  /\bsetup_worktree\b/,
  /\bserialize_merge\b/,
  /\bmerge_orchestrate\b/,
  /\bprune_worktrees\b/,
  /\bcreate_pr\b/,
  /\bmerge_pr\b/,
  /\badd_pr_comment\b/,
  /\bcreate_issue\b/,
  /\bmerge-orchestrate\b/,
];

/** Skills that use VCS operations. Each one must hold a VCS preamble. */
const SKILLS_REQUIRING_VCS_PREAMBLE = [
  'synthesize',
  'shepherd',
  'cleanup',
  'dogfood',
  'prune',
  'oneshot',
];

describe('skill-migration — T34: gh to MCP action migration', () => {
  /** Only a Markdown table row can name `gh pr create`. */
  it('NoActionableGhPrCreate_InSkillSources', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh pr create\b/.test(line)) {
          const isAllowed =
            /\|.*gh pr create.*\|/.test(line) ||
            false;
          if (!isAllowed) {
            violations.push({
              file: relToSkillsSrc(file),
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh pr create' references. Skill content stays harness-neutral for VCS writes: the coordinator creates each PR through its harness, outside governance:\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  /** Only a Markdown table row can name `gh pr merge`. */
  it('NoActionableGhPrMerge_InSkillSources', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh pr merge\b/.test(line)) {
          const isAllowed = /\|.*gh pr merge.*\|/.test(line);
          if (!isAllowed) {
            violations.push({
              file: relToSkillsSrc(file),
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh pr merge' references. Skill content stays harness-neutral for VCS writes: the coordinator merges each PR through its harness, outside governance:\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
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
            file: relToSkillsSrc(file),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh issue create' references. Skill content stays harness-neutral for VCS writes: the coordinator files each issue through its harness, outside governance:\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
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
            file: relToSkillsSrc(file),
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
        if (/\bgh pr view\s+\S+\s+--json\s+(?:reviews|comments|reviews,comments)\b/.test(line)) {
          violations.push({
            file: relToSkillsSrc(file),
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
            file: relToSkillsSrc(file),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} actionable 'gh pr comment' references. Skill content stays harness-neutral for VCS writes: the coordinator posts each comment through its harness, outside governance:\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });

  /**
   * Three contexts can name `gh pr list`:
   * - the prune files in `ALLOWED_FILES`, because the prune safeguards use `gh` internally
   * - a Markdown table row
   * - text with the word "from" directly before the command in backticks
   * `ALLOWED_FILES` matches the path below the skill, not the path below the content root.
   * Thus a move of the skill to another domain does not remove the exemption.
   */
  it('NoActionableGhPrList_InSkillSources_ExceptAllowedContexts', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    const ALLOWED_FILES = [
      'prune/references/safeguards.md',
      'prune/SKILL.md',
    ];

    for (const file of files) {
      const relPath = relToSkillsSrc(file);
      if (ALLOWED_FILES.some((allowed) => relPath.endsWith(allowed))) continue;

      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh pr list\b/.test(line)) {
          const isAllowed =
            /\|.*gh pr list.*\|/.test(line) ||
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

  /**
   * Two kinds of line can name `gh pr view`: a Markdown table row, and a line with `--json autoMergeRequest`.
   * No MCP action does the auto-merge check.
   */
  it('NoActionableGhPrView_InSkillSources_ExceptAllowedOperations', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const relPath = relToSkillsSrc(file);
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bgh pr view\b/.test(line)) {
          const isAllowed =
            /--json\s+autoMergeRequest/.test(line) ||
            /\|.*gh pr view.*\|/.test(line);
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
      const relPath = relToSkillsSrc(file);
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
   * Each skill in `SKILLS_REQUIRING_VCS_PREAMBLE` must hold a `## VCS Provider` section.
   * `resolveSkillPath` finds each skill in its domain, and it throws for a skill that no domain holds.
   * The case also asserts that each of the six skills resolves, so it cannot pass on an empty set.
   */
  it('VcsPreamble_PresentInAffectedSkills', () => {
    const missing: string[] = [];
    const resolved: string[] = [];

    for (const skillName of SKILLS_REQUIRING_VCS_PREAMBLE) {
      const skillPath = resolveSkillPath(skillName);
      resolved.push(skillName);
      const content = readFileSync(skillPath, 'utf8');
      if (!content.includes('## VCS Provider')) {
        missing.push(skillName);
      }
    }

    expect(resolved).toEqual(SKILLS_REQUIRING_VCS_PREAMBLE);
    expect(resolved).toHaveLength(6);
    expect(
      missing,
      `Skills missing VCS Provider preamble: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /** The synthesize skill names no `create_pr` or `merge_pr` action, and it names the harness hand-off for the PR creation and the auto-merge. */
  it('McpActionReferences_Synthesize_LeavesPrCreationAndMergeToTheHarness', () => {
    const synthSkillPath = resolveSkillPath('synthesize');
    const content = readFileSync(synthSkillPath, 'utf8');

    expect(content).not.toContain('action: "create_pr"');
    expect(content).not.toContain('action: "merge_pr"');
    expect(content).toContain('the coordinator creates the PR through its harness, outside governance.');
    expect(content).toContain('the coordinator enables auto-merge on the PR through its harness, outside governance');
  });

  it('McpActionReferences_ListPrs_PresentInMigratedSkills', () => {
    const synthSkillPath = resolveSkillPath('synthesize');
    const content = readFileSync(synthSkillPath, 'utf8');

    expect(content).toContain('action: "list_prs"');
  });

  it('McpActionReferences_Dogfood_LeavesIssueFilingToTheHarness', () => {
    const dogfoodPath = resolveSkillPath('dogfood');
    const content = readFileSync(dogfoodPath, 'utf8');

    expect(content).not.toContain('action: "create_issue"');
    expect(content).toContain('the coordinator files the issue through its harness, outside governance.');
  });

  it('McpActionReferences_CheckCi_PresentInTroubleshooting', () => {
    const troublePath = resolveSkillReference('synthesize', 'troubleshooting.md');
    const content = readFileSync(troublePath, 'utf8');

    expect(content).toContain('action: "check_ci"');
  });

  /**
   * No Markdown source under `content/` names a retired action or the retired `merge-orchestrate` CLI verb, in prose or in an example.
   * The case also asserts that it scanned at least one file, so it cannot pass on an empty set.
   */
  it('RetiredActions_NamedByNoSkillSource', () => {
    const files = collectMarkdownFiles(SKILLS_SRC_DIR);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (RETIRED_ACTION_PATTERNS.some((pattern) => pattern.test(line))) {
          violations.push({ file: relToSkillsSrc(file), line: i + 1, text: line.trim() });
        }
      }
    }

    expect(files.length).toBeGreaterThan(0);
    expect(
      violations,
      `Found ${violations.length} references to a retired action. The coordinator does these effects through its harness, outside governance:\n${violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}`,
    ).toEqual([]);
  });
});
