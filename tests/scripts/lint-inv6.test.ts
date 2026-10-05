/** Tests for `tools/audit/gates/lint-inv6.mjs`, the advisory lint for workflow agnosticism in skills. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

import { spawnAsync } from '../../tools/test-helpers/spawn.js';

const REPO_ROOT = path.resolve(__dirname, '../..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'tools', 'audit', 'gates', 'lint-inv6.mjs');

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly rule: string;
  readonly severity?: string;
  readonly message?: string;
}

interface LintOutput {
  readonly findings: ReadonlyArray<Finding>;
  readonly advisory: boolean;
}

async function runLint(arg: string): Promise<{ stdout: string; status: number }> {
  const result = await spawnAsync('node', [LINT_SCRIPT, arg], { cwd: REPO_ROOT });
  return { stdout: result.stdout, status: result.status ?? 1 };
}

describe('lint-inv6', () => {
  /** Both fixtures hold the same literal. Only the fixture without a `workflow-type` declaration gets a finding. */
  it('LintINV6_FlagsWorkflowTypeLiterals_NonZeroFindings', async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-'));
    try {
      const flaggedDir = path.join(tmpdir, 'flagged-skill');
      const cleanDir = path.join(tmpdir, 'clean-skill');
      fs.mkdirSync(flaggedDir, { recursive: true });
      fs.mkdirSync(cleanDir, { recursive: true });

      const flaggedBody = [
        '---',
        'name: flagged-skill',
        'description: "Demonstrate INV-6 leak."',
        '---',
        '',
        '# Flagged skill',
        '',
        'When you reach `feature/merge-pending`, do the rebase.',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(flaggedDir, 'SKILL.md'), flaggedBody, 'utf8');

      const cleanBody = [
        '---',
        'name: clean-skill',
        'description: "Demonstrate INV-6 declared escape hatch."',
        'metadata:',
        '  workflow-type: feature',
        '---',
        '',
        '# Clean skill',
        '',
        'When you reach `feature/merge-pending`, do the rebase.',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(cleanDir, 'SKILL.md'), cleanBody, 'utf8');

      const { stdout, status } = await runLint(tmpdir);
      expect(status, 'lint must exit 0 (advisory)').toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      expect(out.advisory).toBe(true);
      const flagged = out.findings.filter((f) =>
        f.file.includes(path.join('flagged-skill', 'SKILL.md')),
      );
      const clean = out.findings.filter((f) =>
        f.file.includes(path.join('clean-skill', 'SKILL.md')),
      );
      expect(clean.length, 'clean skill must not be flagged (workflow-type declared)').toBe(0);
      expect(flagged.length, 'flagged skill must be reported').toBeGreaterThanOrEqual(1);
      for (const f of flagged) {
        expect(f.rule).toBe('workflow-type-literal-without-declaration');
      }
    } finally {
      rmrf(tmpdir);
    }
  });

  it('LintINV6_RunsAdvisoryAgainstRealCatalog_ExitsZero', async () => {
    const { stdout, status } = await runLint('content/');
    expect(status, 'lint must exit 0 even with findings (advisory)').toBe(0);
    const out = JSON.parse(stdout) as LintOutput;
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.advisory).toBe(true);
  });
});

/**
 * Writes `<tmpdir>/<name>/SKILL.md` with `body`.
 * The `metadataExtra` lines go under a `metadata:` key in the frontmatter.
 */
function makeSkillFixture(
  tmpdir: string,
  name: string,
  body: string,
  metadataExtra: readonly string[] = [],
): string {
  const dir = path.join(tmpdir, name);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatterLines = [
    '---',
    `name: ${name}`,
    `description: "Fixture skill for lint-inv6 tests."`,
    ...(metadataExtra.length > 0 ? ['metadata:', ...metadataExtra.map((l) => `  ${l}`)] : []),
    '---',
    '',
  ];
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatterLines.join('\n') + body, 'utf8');
  return dir;
}

function findingsFor(out: LintOutput, dirName: string): Finding[] {
  return out.findings.filter((f) => f.file.includes(path.join(dirName, 'SKILL.md')));
}

describe('lint-inv6 — literal narrowing (T-22)', () => {
  /**
   * The fixture uses the four phrase literals as plain English and declares no `workflow-type`.
   * The lint must stay silent.
   */
  it('LintINV6_ProseUsageOfBareVerbLiterals_YieldsZeroFindings', async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-prose-'));
    try {
      const body = [
        '# Prose skill',
        '',
        'Once the implementation is ready, review the changes carefully and',
        'ask a teammate to delegate the remaining polish work if capacity allows.',
        '',
        'The synthesize step wraps up gathering all the outputs produced during',
        'the gathering phase into a single summary for the reader.',
        '',
      ].join('\n');
      makeSkillFixture(tmpdir, 'prose-skill', body);

      const { stdout, status } = await runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      const findings = findingsFor(out, 'prose-skill');
      expect(
        findings.map((f) => f.snippet),
        'prose usage of review/delegate/synthesize/gathering must not be flagged',
      ).toEqual([]);
    } finally {
      rmrf(tmpdir);
    }
  });

  /**
   * The fixture holds real structural coupling and declares no `workflow-type`.
   * A lint without its literals passes the prose test, but it fails this test.
   */
  it('LintINV6_GenuineWorkflowCoupling_StillFlagged', async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-coupled-'));
    try {
      const body = [
        '# Coupled skill',
        '',
        'Create a `feature/` branch for this change.',
        'Set the state to `merge-pending` once the PR is up.',
        '',
        '```yaml',
        'phase: delegate',
        '```',
        '',
        'Run `/synthesize` once every task is complete.',
        '',
      ].join('\n');
      makeSkillFixture(tmpdir, 'coupled-skill', body);

      const { stdout, status } = await runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      const findings = findingsFor(out, 'coupled-skill');
      expect(findings.length, 'genuine workflow coupling must still be flagged').toBeGreaterThanOrEqual(4);
      const matchedLiterals = new Set(
        findings.map((f) => (f.message ?? '').match(/literal "([^"]+)"/)?.[1]),
      );
      expect(matchedLiterals.has('feature/'), 'feature/ branch prefix must be flagged').toBe(true);
      expect(matchedLiterals.has('merge-pending'), 'merge-pending state value must be flagged').toBe(
        true,
      );
      expect(matchedLiterals.has('delegate'), 'phase: delegate assignment must be flagged').toBe(true);
      expect(matchedLiterals.has('synthesize'), '/synthesize slash command must be flagged').toBe(
        true,
      );
    } finally {
      rmrf(tmpdir);
    }
  });

  /**
   * Each workflow type uses `featureId` as its identifier, so a skill that names it stays workflow-agnostic.
   * The lint must not flag `featureId` in a code span, a JSON value or plain prose.
   */
  it('LintINV6_FeatureIdUsage_NeverFlagged_NotAWorkflowTypeLiteral', async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-featureid-'));
    try {
      const body = [
        '# featureId skill',
        '',
        'Read state with `featureId: "<id>"`.',
        '',
        '```json',
        '{ "action": "update", "featureId": "<id>", "updates": {} }',
        '```',
        '',
        'Every workflow type is tracked by its featureId in the event stream.',
        '',
      ].join('\n');
      makeSkillFixture(tmpdir, 'featureid-skill', body);

      const { stdout, status } = await runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      expect(
        findingsFor(out, 'featureid-skill'),
        'featureId must never be flagged in any context — it is not a workflow-type literal',
      ).toEqual([]);
    } finally {
      rmrf(tmpdir);
    }
  });

  /** A longer word such as `reviewer` or `delegated` must not match `review` or `delegate`. */
  it('LintINV6_LongerWordsContainingLiterals_DoNotTripWordBoundary', async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-boundary-'));
    try {
      const body = [
        '# Boundary skill',
        '',
        'The reviewer approved the change after previewing the full diff.',
        'The task was delegated to a teammate and reviewed twice before merge.',
        '',
      ].join('\n');
      makeSkillFixture(tmpdir, 'boundary-skill', body);

      const { stdout, status } = await runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      const findings = findingsFor(out, 'boundary-skill');
      expect(
        findings.map((f) => f.snippet),
        'reviewer/previewing/delegated/reviewed must not trip review/delegate',
      ).toEqual([]);
    } finally {
      rmrf(tmpdir);
    }
  });

  /** A `metadata.workflow-type` declaration silences a skill that the lint otherwise flags. */
  it('LintINV6_WorkflowTypeFrontmatterDeclared_StillSuppressesFindings', async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-declared-'));
    try {
      const body = [
        '# Declared skill',
        '',
        'Run `/synthesize` once the `phase: delegate` step finishes on the `feature/` branch.',
        '',
      ].join('\n');
      makeSkillFixture(tmpdir, 'declared-skill', body, ['workflow-type: feature']);

      const { stdout, status } = await runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      expect(findingsFor(out, 'declared-skill')).toEqual([]);
    } finally {
      rmrf(tmpdir);
    }
  });

  /** A skill under `_shared/` is exempt, also when it holds flagged literals. */
  it('LintINV6_SharedDirectory_StillExempt', async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-shared-'));
    try {
      const sharedDir = path.join(tmpdir, '_shared', 'some-shared-skill');
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(
        path.join(sharedDir, 'SKILL.md'),
        [
          '---',
          'name: some-shared-skill',
          'description: "Shared skill fixture."',
          '---',
          '',
          'Run `/synthesize` once the `phase: delegate` step finishes on the `feature/` branch.',
          '',
        ].join('\n'),
        'utf8',
      );

      const { stdout, status } = await runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      expect(out.findings).toEqual([]);
    } finally {
      rmrf(tmpdir);
    }
  });

  /** The lint is advisory. With findings, it still exits 0 and prints the same JSON shape. */
  it('LintINV6_ExitCodeAndShape_UnchangedEvenWithFindings', async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-shape-'));
    try {
      makeSkillFixture(
        tmpdir,
        'shape-skill',
        ['# Shape skill', '', 'Track the workflow on the `feature/` branch.', ''].join('\n'),
      );

      const { stdout, status } = await runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      expect(out.advisory).toBe(true);
      expect(Array.isArray(out.findings)).toBe(true);
      const findings = findingsFor(out, 'shape-skill');
      expect(findings.length).toBeGreaterThanOrEqual(1);
      for (const f of findings) {
        expect(typeof f.file).toBe('string');
        expect(typeof f.line).toBe('number');
        expect(typeof f.snippet).toBe('string');
        expect(f.rule).toBe('workflow-type-literal-without-declaration');
        expect(typeof f.severity).toBe('string');
        expect(typeof f.message).toBe('string');
      }
    } finally {
      rmrf(tmpdir);
    }
  });

  /**
   * Pins a ceiling on the finding count for `content/`, with headroom for catalog growth.
   * A regression in the literal matching increases the count.
   * `featureId` must never be a matched literal on the real tree.
   */
  it('LintINV6_RealSkillsTree_FindingCountAtOrBelowAttainedThreshold', async () => {
    const { stdout, status } = await runLint('content/');
    expect(status).toBe(0);
    const out = JSON.parse(stdout) as LintOutput;
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.findings.length).toBeLessThan(130);
    const literalsSeen = new Set(
      out.findings.map((f) => (f.message ?? '').match(/literal "([^"]+)"/)?.[1]),
    );
    expect(literalsSeen.has('featureId'), 'featureId must never be a matched literal').toBe(false);
  });

  /**
   * Declares `workflow-type` on each flagged skill in a temporary copy of `content/`, then expects zero findings.
   * This proves that the declaration can clear every finding that remains on the real tree.
   * The declaration goes at the top level, because the lint accepts the key at any indentation.
   */
  it('LintINV6_DeclaringWorkflowTypeOnEveryResidualSkill_ClearsAllFindings', async () => {
    const before = JSON.parse((await runLint('content/')).stdout) as LintOutput;
    const flaggedFiles = [...new Set(before.findings.map((f) => f.file))];
    expect(
      flaggedFiles.length,
      'sanity: the real tree must have residual findings for this test to be meaningful',
    ).toBeGreaterThan(0);

    const skillsSrcRoot = path.join(REPO_ROOT, 'content');
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-escape-hatch-'));
    try {
      fs.cpSync(skillsSrcRoot, tmpdir, { recursive: true });
      for (const file of flaggedFiles) {
        const rel = path.relative(skillsSrcRoot, file);
        const tmpFile = path.join(tmpdir, rel);
        const original = fs.readFileSync(tmpFile, 'utf8');
        expect(
          original.startsWith('---\n'),
          `${rel} must have frontmatter to declare workflow-type into`,
        ).toBe(true);
        fs.writeFileSync(tmpFile, original.replace(/^---\n/, '---\nworkflow-type: core\n'), 'utf8');
      }

      const after = JSON.parse((await runLint(tmpdir)).stdout) as LintOutput;
      expect(
        after.findings.map((f) => path.relative(tmpdir, f.file)),
        'declaring workflow-type on every currently-flagged skill must clear all residual findings',
      ).toEqual([]);
    } finally {
      rmrf(tmpdir);
    }
  });
});
