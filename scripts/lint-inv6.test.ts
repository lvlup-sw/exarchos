// Tests for `scripts/lint-inv6.mjs` — the advisory grep-based lint that
// surfaces candidate INV-6 (workflow-agnosticism) violations.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-inv6.mjs');

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

function runLint(arg: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [LINT_SCRIPT, arg], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

describe('lint-inv6', () => {
  it('LintINV6_FlagsWorkflowTypeLiterals_NonZeroFindings', () => {
    // Set up a tmpdir with two synthetic skill SKILL.md files:
    //  - flagged: contains `feature/merge-pending` literal and NO
    //    `workflow-type:` frontmatter
    //  - clean:   declares `workflow-type: feature` in frontmatter
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

      const { stdout, status } = runLint(tmpdir);
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
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('LintINV6_RunsAdvisoryAgainstRealCatalog_ExitsZero', () => {
    const { stdout, status } = runLint('content/');
    expect(status, 'lint must exit 0 even with findings (advisory)').toBe(0);
    const out = JSON.parse(stdout) as LintOutput;
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.advisory).toBe(true);
  });
});

// ─── T-22: literal narrowing (prose no longer trips the bare-verb literals) ─

/** Create a tmpdir holding a single `<name>/SKILL.md` with the given body
 * (and optional extra frontmatter lines inserted under `metadata:`). */
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
  it('LintINV6_ProseUsageOfBareVerbLiterals_YieldsZeroFindings', () => {
    // The headline acceptance fixture: ordinary sentences using the four
    // bare-verb/noun literals as plain English, with no declared
    // `workflow-type` escape hatch. Narrowing must make this silent.
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

      const { stdout, status } = runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      const findings = findingsFor(out, 'prose-skill');
      expect(
        findings.map((f) => f.snippet),
        'prose usage of review/delegate/synthesize/gathering must not be flagged',
      ).toEqual([]);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('LintINV6_GenuineWorkflowCoupling_StillFlagged', () => {
    // The negative twin: real structural coupling — a hard-coded `feature/`
    // branch prefix, a `merge-pending` state value, a `phase: delegate`
    // assignment, and a `/synthesize` slash command — with NO
    // `workflow-type` declaration. A "narrowing" that just deleted the
    // literals would pass the prose test above but go silent here too;
    // this must still fire. (`featureId` is deliberately NOT part of this
    // fixture — see `LintINV6_FeatureIdUsage_NeverFlagged_NotAWorkflowTypeLiteral`
    // below for why it was removed from detection entirely rather than
    // narrowed.)
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

      const { stdout, status } = runLint(tmpdir);
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
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('LintINV6_FeatureIdUsage_NeverFlagged_NotAWorkflowTypeLiteral', () => {
    // `featureId` is the universal stream/workflow identifier parameter —
    // used identically by every workflow type (feature, refactor, debug,
    // oneshot, discover, ...). A skill referencing it is being
    // workflow-AGNOSTIC, which is exactly what INV-6 asks for, not a
    // violation of it. This was 96 of the pre-fix 196 residual findings —
    // the single largest component — and its removal from the literal set
    // (rather than narrowing) is what this test pins: no context in which
    // `featureId` appears (quoted, code span, key-value, or plain prose)
    // should ever produce a finding, with no `workflow-type` declared.
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

      const { stdout, status } = runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      expect(
        findingsFor(out, 'featureid-skill'),
        'featureId must never be flagged in any context — it is not a workflow-type literal',
      ).toEqual([]);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('LintINV6_LongerWordsContainingLiterals_DoNotTripWordBoundary', () => {
    // reviewer / previewing / delegated / reviewed must NOT trip `review` /
    // `delegate` — the old `String.includes` had no boundary logic at all.
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

      const { stdout, status } = runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      const findings = findingsFor(out, 'boundary-skill');
      expect(
        findings.map((f) => f.snippet),
        'reviewer/previewing/delegated/reviewed must not trip review/delegate',
      ).toEqual([]);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('LintINV6_WorkflowTypeFrontmatterDeclared_StillSuppressesFindings', () => {
    // Contract preservation: the `metadata.workflow-type:` escape hatch
    // still silences an otherwise-flagged skill, even with the narrowed
    // literal detection.
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-declared-'));
    try {
      const body = [
        '# Declared skill',
        '',
        'Run `/synthesize` once the `phase: delegate` step finishes on the `feature/` branch.',
        '',
      ].join('\n');
      makeSkillFixture(tmpdir, 'declared-skill', body, ['workflow-type: feature']);

      const { stdout, status } = runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      expect(findingsFor(out, 'declared-skill')).toEqual([]);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('LintINV6_SharedDirectory_StillExempt', () => {
    // Contract preservation: `_shared/` skills remain exempt regardless of
    // literal narrowing.
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

      const { stdout, status } = runLint(tmpdir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      expect(out.findings).toEqual([]);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('LintINV6_ExitCodeAndShape_UnchangedEvenWithFindings', () => {
    // Contract preservation: exit code stays 0 (advisory) and the JSON shape
    // (`{findings: [...], advisory: true}` with per-finding `file`/`line`/
    // `snippet`/`rule`/`severity`/`message`) is unchanged.
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-shape-'));
    try {
      makeSkillFixture(
        tmpdir,
        'shape-skill',
        ['# Shape skill', '', 'Track the workflow on the `feature/` branch.', ''].join('\n'),
      );

      const { stdout, status } = runLint(tmpdir);
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
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('LintINV6_RealSkillsTree_FindingCountAtOrBelowAttainedThreshold', () => {
    // Threshold-attainability measurement: narrowing the bare-verb literals
    // (354 -> 196) and then removing the mis-scoped `featureId` literal
    // entirely (196 -> ~103, measured at the time of T-22's second pass)
    // must bring the real-tree finding count down to a small, stable,
    // attained count. This pins the narrowed baseline so a future
    // regression — either a prose false-positive creeping back in, or
    // `featureId` being re-added to the literal set — is visible as a test
    // failure rather than silently ballooning findings back toward
    // "unreachable zero" territory.
    const { stdout, status } = runLint('content/');
    expect(status).toBe(0);
    const out = JSON.parse(stdout) as LintOutput;
    expect(Array.isArray(out.findings)).toBe(true);
    // Comfortably below both the pre-narrowing baseline (354) and the
    // first-pass narrowed baseline (196), with modest headroom above the
    // measured second-pass count (103) for incidental catalog growth that
    // doesn't regress the narrowing itself.
    expect(out.findings.length).toBeLessThan(130);
    // Regression guard for the `featureId` fix specifically: it must never
    // reappear as a matched literal on the real tree.
    const literalsSeen = new Set(
      out.findings.map((f) => (f.message ?? '').match(/literal "([^"]+)"/)?.[1]),
    );
    expect(literalsSeen.has('featureId'), 'featureId must never be a matched literal').toBe(false);
  });

  it('LintINV6_DeclaringWorkflowTypeOnEveryResidualSkill_ClearsAllFindings', () => {
    // Crisp verdict on the remainder (T-22 second pass): every surviving
    // real-tree finding is either (a) genuine coupling a human could fix,
    // or (b) clearable by declaring `metadata.workflow-type:` on that
    // (workflow-machinery) skill — the escape hatch the script already
    // implements. Prove (b) covers the WHOLE remainder by declaring the
    // hatch on every currently-flagged skill in a TEMP COPY of the real
    // tree (content/ itself is never touched) and showing findings drop
    // to exactly zero. If some residual finding were neither (a) nor (b),
    // it would still be present here.
    const before = JSON.parse(runLint('content/').stdout) as LintOutput;
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
        // Insert a top-level `workflow-type:` declaration — the frontmatter
        // check matches the key at ANY indentation, so this does not need
        // to nest under the existing `metadata:` block.
        fs.writeFileSync(tmpFile, original.replace(/^---\n/, '---\nworkflow-type: core\n'), 'utf8');
      }

      const after = JSON.parse(runLint(tmpdir).stdout) as LintOutput;
      expect(
        after.findings.map((f) => path.relative(tmpdir, f.file)),
        'declaring workflow-type on every currently-flagged skill must clear all residual findings',
      ).toEqual([]);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});
