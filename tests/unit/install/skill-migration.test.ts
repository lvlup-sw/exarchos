/**
 * Tests that skill content leaves VCS writes to the harness and VCS reads to the agent.
 * A source under `content/` names no actionable `gh pr create`, `gh pr merge`, `gh pr comment` or `gh issue create`.
 * The harness of the coordinator owns these writes.
 *
 * No Markdown source under `content/` tells the agent to read PR, CI or review state through an Exarchos action.
 * The agent reads that state with its own tools, such as `gh`, and records shepherd events with `exarchos_event`.
 * A skill that uses VCS operations must hold a VCS provider preamble.
 * No Markdown source under `content/` names a retired action.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { skillPath as resolveSkillPath, skillReference as resolveSkillReference } from '../../../tools/test-helpers/content-tree.js';
import { extractToolExamples } from '../../../src/projections/quality/skill-example-validator.js';

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

type Violation = { file: string; line: number; text: string };

/**
 * Gives each line of a Markdown source under `content/` that matches one of the patterns.
 * It also gives the count of scanned files, so a caller can refuse an empty scan.
 */
function scanSkillSources(patterns: readonly RegExp[]): { scanned: number; violations: Violation[] } {
  const files = collectMarkdownFiles(SKILLS_SRC_DIR);
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (patterns.some((pattern) => pattern.test(line))) {
        violations.push({ file: relToSkillsSrc(file), line: i + 1, text: line.trim() });
      }
    }
  }
  return { scanned: files.length, violations };
}

function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n');
}

const AGENT_READ_GUIDANCE =
  'The agent reads PR, CI and review state with its own tools, such as gh, and records shepherd events with exarchos_event.';

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

/** The preamble sentence that tells the agent to read PR state with its own tools. */
const OWN_TOOLS_READ_SENTENCE = 'Exarchos reads no PR, CI or review state, and it does no VCS write.';

/** Skills that use VCS operations. Each one must hold a VCS preamble. */
const SKILLS_REQUIRING_VCS_PREAMBLE = [
  'synthesize',
  'shepherd',
  'cleanup',
  'dogfood',
  'prune',
  'oneshot',
];

/** Skills that read PR state. Each preamble states that the agent reads it with its own tools. Prune reads the open PRs of its candidates. */
const SKILLS_READING_PR_STATE = ['synthesize', 'shepherd', 'cleanup', 'prune'];

describe('skill-migration — harness-owned VCS writes and agent-owned VCS reads', () => {
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

  /** No Markdown source under `content/` names the `check_ci` read. The agent reads CI state with its own tools. */
  it('NoCheckCiRead_InSkillSources', () => {
    const { scanned, violations } = scanSkillSources([/\bcheck_ci\b/]);

    expect(scanned).toBeGreaterThan(0);
    expect(
      violations,
      `Found ${violations.length} references to the check_ci read. ${AGENT_READ_GUIDANCE}\n${formatViolations(violations)}`,
    ).toEqual([]);
  });

  /** No Markdown source under `content/` names the `get_pr_comments` read. The agent reads PR comments with its own tools. */
  it('NoGetPrCommentsRead_InSkillSources', () => {
    const { scanned, violations } = scanSkillSources([/\bget_pr_comments\b/]);

    expect(scanned).toBeGreaterThan(0);
    expect(
      violations,
      `Found ${violations.length} references to the get_pr_comments read. ${AGENT_READ_GUIDANCE}\n${formatViolations(violations)}`,
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

  /** No Markdown source under `content/` names the `list_prs` read. The agent lists PRs with its own tools. */
  it('NoListPrsRead_InSkillSources', () => {
    const { scanned, violations } = scanSkillSources([/\blist_prs\b/]);

    expect(scanned).toBeGreaterThan(0);
    expect(
      violations,
      `Found ${violations.length} references to the list_prs read. ${AGENT_READ_GUIDANCE}\n${formatViolations(violations)}`,
    ).toEqual([]);
  });

  /** No Markdown source under `content/` names the `assess_stack` read. The shepherd assesses each PR from its own reads. */
  it('NoAssessStackRead_InSkillSources', () => {
    const { scanned, violations } = scanSkillSources([/\bassess_stack\b/]);

    expect(scanned).toBeGreaterThan(0);
    expect(
      violations,
      `Found ${violations.length} references to the assess_stack read. ${AGENT_READ_GUIDANCE}\n${formatViolations(violations)}`,
    ).toEqual([]);
  });

  /**
   * No Markdown source under `content/` names a PR gate that reads the provider: `check_pr_comments`,
   * `check_coderabbit` or `validate_pr_stack`. The agent reads the review state and the stack with its own tools.
   */
  it('NoProviderReadingPrGate_InSkillSources', () => {
    const { scanned, violations } = scanSkillSources([
      /\bcheck_pr_comments\b/,
      /\bcheck_coderabbit\b/,
      /\bvalidate_pr_stack\b/,
    ]);

    expect(scanned).toBeGreaterThan(0);
    expect(
      violations,
      `Found ${violations.length} references to a PR gate that reads the provider. ${AGENT_READ_GUIDANCE}\n${formatViolations(violations)}`,
    ).toEqual([]);
  });

  /**
   * Each `validate_pr_body` example under `content/` checks a body text. No example passes `pr`, because the action takes no PR number and reads no PR.
   * The case also asserts that it found at least one example, so it cannot pass on an empty set.
   */
  it('ValidatePrBody_ExamplesCheckBodyTextOnly', () => {
    const examples = collectMarkdownFiles(SKILLS_SRC_DIR).flatMap((file) =>
      extractToolExamples(readFileSync(file, 'utf8'), relToSkillsSrc(file)).filter(
        (example) => example.tool === 'exarchos_orchestrate' && example.action === 'validate_pr_body',
      ),
    );
    const withPr = examples.filter((example) => 'pr' in example.params);
    const withoutBody = examples.filter(
      (example) => !('bodyFile' in example.params) && !('body' in example.params),
    );

    expect(examples.length).toBeGreaterThan(0);
    expect(withPr.map((example) => `${example.file}:${example.line}`)).toEqual([]);
    expect(withoutBody.map((example) => `${example.file}:${example.line}`)).toEqual([]);
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

  /** The preamble of each skill that reads PR state states that Exarchos reads none, and it names `gh` as the own tool for GitHub. */
  it('VcsPreamble_PrReadingSkills_ReadWithTheAgentTools', () => {
    const missing = SKILLS_READING_PR_STATE.filter((skillName) => {
      const content = readFileSync(resolveSkillPath(skillName), 'utf8');
      const start = content.indexOf('## VCS Provider');
      const preamble = start < 0 ? '' : content.slice(start, content.indexOf('\n## ', start + 1));
      return !preamble.includes(OWN_TOOLS_READ_SENTENCE) || !preamble.includes('with your own tools') || !preamble.includes('`gh`');
    });

    expect(SKILLS_READING_PR_STATE).toHaveLength(4);
    expect(missing, `Skills whose VCS preamble does not send PR reads to the agent tools: ${missing.join(', ')}`).toEqual([]);
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

  /** The Idempotency procedure of the synthesize skill reads the PRs of each head with `gh pr list`, filtered by head and base. */
  it('AgentReads_Synthesize_IdempotencyReadsPrsWithTheAgentTools', () => {
    const content = readFileSync(resolveSkillPath('synthesize'), 'utf8');
    const idempotency = content.slice(content.indexOf('## Idempotency'), content.indexOf('## Direct Edits to Stack Branches'));

    expect(idempotency).toContain('The coordinator runs this procedure with its own tools');
    expect(idempotency).toContain('gh pr list --head <head> --base <base> --state all');
    expect(idempotency).toContain('A read that returns as many PRs as its `--limit` is a failed read');
  });

  it('McpActionReferences_Dogfood_LeavesIssueFilingToTheHarness', () => {
    const dogfoodPath = resolveSkillPath('dogfood');
    const content = readFileSync(dogfoodPath, 'utf8');

    expect(content).not.toContain('action: "create_issue"');
    expect(content).toContain('the coordinator files the issue through its harness, outside governance.');
  });

  /** The synthesize troubleshooting guide reads the CI state of a rejected PR with `gh pr checks`. */
  it('AgentReads_Troubleshooting_ReadsCiWithTheAgentTools', () => {
    const content = readFileSync(resolveSkillReference('synthesize', 'troubleshooting.md'), 'utf8');

    expect(content).toContain('Check CI status with your own tools: `gh pr checks <number>`');
  });

  /**
   * The shepherd skill and its references append `shepherd.iteration` and no other `shepherd.*` event.
   * The other four shepherd types are retired as emissions, so no example appends them.
   */
  it('AgentReads_Shepherd_AppendsOnlyShepherdIteration', () => {
    const texts = [
      readFileSync(resolveSkillPath('shepherd'), 'utf8'),
      readFileSync(resolveSkillReference('shepherd', 'escalation-criteria.md'), 'utf8'),
      readFileSync(resolveSkillReference('shepherd', 'shepherd-event-schemas.md'), 'utf8'),
    ];
    const appended = new Set(texts.flatMap((text) => [...text.matchAll(/type: "(shepherd\.[a-z_]+)"/g)].map((m) => m[1])));

    expect([...appended]).toEqual(['shepherd.iteration']);
    expect(texts[0]).toContain('No Exarchos action reads a PR or appends a `shepherd.*` event for you.');
    expect(texts[0]).toContain('`shepherd.iteration` is the only `shepherd.*` event that you append.');
  });

  /**
   * No Markdown source under `content/` names a retired action or the retired `merge-orchestrate` CLI verb, in prose or in an example.
   * The case also asserts that it scanned at least one file, so it cannot pass on an empty set.
   */
  it('RetiredActions_NamedByNoSkillSource', () => {
    const { scanned, violations } = scanSkillSources(RETIRED_ACTION_PATTERNS);

    expect(scanned).toBeGreaterThan(0);
    expect(
      violations,
      `Found ${violations.length} references to a retired action. The coordinator does these effects through its harness, outside governance:\n${formatViolations(violations)}`,
    ).toEqual([]);
  });
});
