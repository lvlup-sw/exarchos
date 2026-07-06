/**
 * Tests for the placeholder vocabulary lint.
 *
 * The lint walks a source skill tree (`skills-src/`), extracts every
 * `{{TOKEN}}` reference from every `SKILL.md` (and runtime-override
 * `SKILL.<runtime>.md`) file, and flags any token name that is not in
 * the canonical vocabulary. References (`references/**`) are skipped
 * because they are copied verbatim by `buildAllSkills` and may contain
 * unrelated handlebar-style templating.
 *
 * Implements: DR-3 (lint path). Task 024 RED.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  lintPlaceholders,
  DEFAULT_PLACEHOLDER_VOCABULARY,
} from './placeholder-lint.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'placeholder-lint-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('placeholder-lint — task 024', () => {
  it('PlaceholderLint_KnownToken_Passes', () => {
    // A skill source that uses only canonical vocabulary tokens should
    // lint clean.
    const sourcesDir = makeTempDir();
    mkdirSync(join(sourcesDir, 'foo'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'foo', 'SKILL.md'),
      [
        'Run `{{COMMAND_PREFIX}}plan` to start.',
        '',
        'Then call {{MCP_PREFIX}}workflow_start.',
        '',
        '{{CHAIN next="plan" args="<design>"}}',
        '',
        '{{SPAWN_AGENT_CALL description="do thing" prompt="context here"}}',
        '',
        'Task tool: {{TASK_TOOL}}',
        '',
      ].join('\n'),
    );

    const result = lintPlaceholders({ sourcesDir });

    expect(result.passed).toBe(true);
    expect(result.unknownTokens).toEqual([]);
  });

  it('PlaceholderLint_UnknownToken_FailsWithVocabularyList', () => {
    // A skill source that uses a token not in the vocabulary should
    // fail, and the failure report should surface the canonical
    // vocabulary so developers can see what is allowed.
    const sourcesDir = makeTempDir();
    mkdirSync(join(sourcesDir, 'foo'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'foo', 'SKILL.md'),
      [
        'Known: {{MCP_PREFIX}}',
        'Bogus: {{NOT_A_REAL_TOKEN}}',
        '',
      ].join('\n'),
    );

    const result = lintPlaceholders({ sourcesDir });

    expect(result.passed).toBe(false);
    expect(result.unknownTokens.length).toBe(1);
    const unknown = result.unknownTokens[0];
    expect(unknown.token).toBe('NOT_A_REAL_TOKEN');
    expect(unknown.file).toMatch(/foo[\\/]SKILL\.md$/);
    expect(unknown.line).toBe(2);

    // The aggregated error message must name every token in the
    // canonical vocabulary so developers can see what *is* allowed.
    expect(result.message).toBeDefined();
    for (const known of DEFAULT_PLACEHOLDER_VOCABULARY) {
      expect(result.message).toContain(known);
    }
    // And it must name the offending token so the remediation is obvious.
    expect(result.message).toContain('NOT_A_REAL_TOKEN');
  });

  it('PlaceholderLint_RunsOnAllSources_AggregatesErrors', () => {
    // Multiple skills, each with unknown tokens — the lint must report
    // *all* offenders in a single pass rather than stopping at the first.
    const sourcesDir = makeTempDir();
    mkdirSync(join(sourcesDir, 'alpha'), { recursive: true });
    mkdirSync(join(sourcesDir, 'beta'), { recursive: true });
    mkdirSync(join(sourcesDir, 'gamma'), { recursive: true });

    writeFileSync(
      join(sourcesDir, 'alpha', 'SKILL.md'),
      'Good: {{CHAIN}} bad: {{FOO_BAR}}\n',
    );
    writeFileSync(
      join(sourcesDir, 'beta', 'SKILL.md'),
      '{{MCP_PREFIX}}\n{{SOMETHING_ELSE}}\n',
    );
    // gamma has two unknowns on different lines of the same file.
    writeFileSync(
      join(sourcesDir, 'gamma', 'SKILL.md'),
      'line 1 {{CHAIN}}\nline 2 {{WIDGET}}\nline 3 {{GADGET}}\n',
    );

    // Also drop a `references/` file with a handlebar-style token to
    // prove the lint does not scan references — those are copied verbatim
    // and may legitimately contain non-canonical templating.
    mkdirSync(join(sourcesDir, 'alpha', 'references'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'alpha', 'references', 'note.md'),
      '{{ignored_handlebar}}\n',
    );

    const result = lintPlaceholders({ sourcesDir });

    expect(result.passed).toBe(false);
    // Exactly four unknowns: FOO_BAR, SOMETHING_ELSE, WIDGET, GADGET.
    // The handlebar token in references/note.md must NOT appear.
    const tokens = result.unknownTokens.map((u) => u.token).sort();
    expect(tokens).toEqual(['FOO_BAR', 'GADGET', 'SOMETHING_ELSE', 'WIDGET']);

    // Every offender should be associated with its file path so
    // developers can jump directly to the line.
    const alphaUnknowns = result.unknownTokens.filter((u) =>
      u.file.includes('alpha'),
    );
    const betaUnknowns = result.unknownTokens.filter((u) =>
      u.file.includes('beta'),
    );
    const gammaUnknowns = result.unknownTokens.filter((u) =>
      u.file.includes('gamma'),
    );
    expect(alphaUnknowns.length).toBe(1);
    expect(betaUnknowns.length).toBe(1);
    expect(gammaUnknowns.length).toBe(2);

    // Line numbers must be 1-indexed and accurate.
    expect(betaUnknowns[0].line).toBe(2);
    const gammaLines = gammaUnknowns.map((u) => u.line).sort();
    expect(gammaLines).toEqual([2, 3]);

    // The aggregated message must mention every offender so CI logs
    // surface all problems at once.
    expect(result.message).toBeDefined();
    expect(result.message).toContain('FOO_BAR');
    expect(result.message).toContain('SOMETHING_ELSE');
    expect(result.message).toContain('WIDGET');
    expect(result.message).toContain('GADGET');
    expect(result.message).not.toContain('ignored_handlebar');
  });

  it('PlaceholderLint_DefaultVocabulary_ContainsCanonicalFiveTokens', () => {
    // Sanity check on the exported constant so a future rename or
    // accidental deletion in `DEFAULT_PLACEHOLDER_VOCABULARY` shows up
    // immediately rather than silently letting unknown tokens through.
    expect(DEFAULT_PLACEHOLDER_VOCABULARY).toEqual(
      expect.arrayContaining([
        'MCP_PREFIX',
        'COMMAND_PREFIX',
        'TASK_TOOL',
        'CHAIN',
        'SPAWN_AGENT_CALL',
      ]),
    );
  });
});

describe('placeholder-lint — task 010 (DR-2/DR-8 mcp__ deprecation)', () => {
  const originalStrict = process.env.EXARCHOS_LINT_STRICT;

  afterEach(() => {
    // Restore EXARCHOS_LINT_STRICT to whatever the surrounding process
    // had — individual tests flip it to exercise strict mode.
    if (originalStrict === undefined) {
      delete process.env.EXARCHOS_LINT_STRICT;
    } else {
      process.env.EXARCHOS_LINT_STRICT = originalStrict;
    }
  });

  it('LintSkillSource_RawMcpPrefix_EmitsDeprecationWarning', () => {
    // A skill source containing a literal `mcp__...` reference should
    // emit a deprecation warning (not an error) during the transition
    // window. The warning must carry enough info for the author to
    // find and fix the reference.
    const sourcesDir = makeTempDir();
    mkdirSync(join(sourcesDir, 'foo'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'foo', 'SKILL.md'),
      [
        'Some intro text.',
        'Call mcp__plugin_exarchos_exarchos__exarchos_workflow like so.',
        'More body.',
        '',
      ].join('\n'),
    );

    // Ensure strict mode is off for this test.
    delete process.env.EXARCHOS_LINT_STRICT;

    const result = lintPlaceholders({ sourcesDir });

    // Non-strict: warning should NOT flip passed=false.
    expect(result.passed).toBe(true);
    expect(result.deprecationWarnings.length).toBe(1);
    const warning = result.deprecationWarnings[0];
    expect(warning.pattern).toBe(
      'mcp__plugin_exarchos_exarchos__exarchos_workflow',
    );
    expect(warning.file).toMatch(/foo[\\/]SKILL\.md$/);
    expect(warning.line).toBe(2);
    // The message should mention the deprecation so callers that print
    // it get the signal too.
    expect(result.message).toContain(
      'mcp__plugin_exarchos_exarchos__exarchos_workflow',
    );
  });

  it('LintSkillSource_CallMacro_NoWarning', () => {
    // A skill source using the new `{{CALL ...}}` macro with no literal
    // `mcp__...` reference should emit no deprecation warnings.
    const sourcesDir = makeTempDir();
    mkdirSync(join(sourcesDir, 'bar'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'bar', 'SKILL.md'),
      [
        'Use the CALL macro to invoke:',
        '{{CALL exarchos_workflow set {"key": "value"}}}',
        'Done.',
        '',
      ].join('\n'),
    );

    delete process.env.EXARCHOS_LINT_STRICT;

    const result = lintPlaceholders({ sourcesDir });

    expect(result.passed).toBe(true);
    expect(result.deprecationWarnings).toEqual([]);
  });

  it('LintSkillSource_RawMcpWithStrictEnv_EmitsError', () => {
    // When EXARCHOS_LINT_STRICT=1 is set, raw `mcp__...` references
    // become hard errors so CI can enforce the migration once the
    // transition window closes.
    const sourcesDir = makeTempDir();
    mkdirSync(join(sourcesDir, 'foo'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'foo', 'SKILL.md'),
      'Still raw: mcp__plugin_exarchos_exarchos__exarchos_event here.\n',
    );

    process.env.EXARCHOS_LINT_STRICT = '1';

    const result = lintPlaceholders({ sourcesDir });

    expect(result.passed).toBe(false);
    expect(result.deprecationWarnings.length).toBe(1);
    expect(result.deprecationWarnings[0].pattern).toBe(
      'mcp__plugin_exarchos_exarchos__exarchos_event',
    );
  });
});

describe('placeholder-lint — task 002 (collapsed-vocabulary rules)', () => {
  it('lintPlaceholders_PrefixTokenInProceduralSkill_Rejected', () => {
    // A *procedural* skill (no orchestration tokens → classifySkill:
    // procedural) that references prefix tokens must be flagged once the
    // collapsed-vocabulary rules are enforced: in the collapsed vocabulary a
    // procedural skill renders once for every runtime from logical prose and
    // must not carry a per-harness prefix token.
    const sourcesDir = makeTempDir();
    mkdirSync(join(sourcesDir, 'proc'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'proc', 'SKILL.md'),
      [
        'Run `{{COMMAND_PREFIX}}plan` to start.',
        '',
        'Then call {{MCP_PREFIX}}workflow_start.',
        '',
      ].join('\n'),
    );

    const result = lintPlaceholders({
      sourcesDir,
      enforceCollapsedVocabulary: true,
    });

    expect(result.passed).toBe(false);
    const violations = result.collapsedVocabularyViolations;
    const tokens = violations.map((v) => v.token).sort();
    expect(tokens).toEqual(['COMMAND_PREFIX', 'MCP_PREFIX']);
    for (const v of violations) {
      expect(v.kind).toBe('prefix');
      expect(v.skillClass).toBe('procedural');
      expect(v.file).toMatch(/proc[\\/]SKILL\.md$/);
    }
    // Line numbers are 1-indexed and accurate.
    const byToken = new Map(violations.map((v) => [v.token, v]));
    expect(byToken.get('COMMAND_PREFIX')!.line).toBe(1);
    expect(byToken.get('MCP_PREFIX')!.line).toBe(3);
    // The aggregated message names every offender so CI logs are actionable.
    expect(result.message).toContain('MCP_PREFIX');
    expect(result.message).toContain('COMMAND_PREFIX');
  });

  it('lintPlaceholders_OrchestrationTokenInOrchestrationSkill_Allowed', () => {
    // A source referencing an orchestration token is classified
    // `orchestration` — the one place orchestration tokens are valid. Prefix
    // tokens are also legitimate there (only *procedural* skills reject them),
    // so an orchestration skill using both raises no collapsed-vocabulary
    // violation even with enforcement on.
    const sourcesDir = makeTempDir();
    mkdirSync(join(sourcesDir, 'orch'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'orch', 'SKILL.md'),
      [
        'Delegate the wave with {{TASK_TOOL}}.',
        '',
        'Then call {{MCP_PREFIX}}workflow_start to record it.',
        '',
      ].join('\n'),
    );

    const result = lintPlaceholders({
      sourcesDir,
      enforceCollapsedVocabulary: true,
    });

    expect(result.collapsedVocabularyViolations).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('lintPlaceholders_PrefixTokenInProceduralSkill_NotEnforcedByDefault', () => {
    // Gate check: with enforcement OFF (the default), the collapsed-vocabulary
    // pass does not run, so the current un-rewritten procedural tree — which
    // still carries prefix tokens — stays green. The rewrite task flips
    // `enforceCollapsedVocabulary` on once those tokens are gone.
    const sourcesDir = makeTempDir();
    mkdirSync(join(sourcesDir, 'proc'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'proc', 'SKILL.md'),
      'Then call {{MCP_PREFIX}}workflow_start.\n',
    );

    const result = lintPlaceholders({ sourcesDir });

    expect(result.collapsedVocabularyViolations).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('placeholder-lint — Task 006 (real procedural tree rewritten to logical prose)', () => {
  const SKILLS_SRC = join(__dirname, '..', 'skills-src');

  it('lintPlaceholders_RewrittenProceduralTree_NoPrefixTokens', () => {
    // After Task 006 the 16 procedural skills render once from logical prose
    // (`exarchos:exarchos_*` / bare verbs) and carry NO prefix tokens. With
    // collapsed-vocabulary enforcement ON, the REAL `skills-src/` tree lints
    // clean: zero collapsed-vocabulary violations. The 3 orchestration skills
    // (`ideate`/`delegate`/`refactor`) legitimately keep prefix tokens, but the
    // rules key on the source's derived class so those raise no violation.
    //
    // Kill-probe: revert the procedural rewrite and a prefix token reappears in
    // a procedural SKILL.md, flipping this to a non-empty `prefix` violation.
    const result = lintPlaceholders({
      sourcesDir: SKILLS_SRC,
      enforceCollapsedVocabulary: true,
    });

    expect(result.collapsedVocabularyViolations).toEqual([]);
    expect(
      result.collapsedVocabularyViolations.filter((v) => v.kind === 'prefix'),
    ).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
