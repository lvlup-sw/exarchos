/**
 * Tests for the placeholder vocabulary lint. The lint reads each `SKILL.md` under a
 * source skill tree and flags each `{{TOKEN}}` that is not in the vocabulary. It does
 * not read `references/` trees, because a reference can hold other templating.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  lintPlaceholders,
  DEFAULT_PLACEHOLDER_VOCABULARY,
} from '../../../src/install/placeholder-lint.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

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
      rmrf(d);
    } catch {
    }
  }
});

describe('placeholder-lint — task 024', () => {
  it('PlaceholderLint_KnownToken_Passes', () => {
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

  /**
   * The message names the unknown token and each token of the vocabulary, so a
   * developer sees what is allowed.
   */
  it('PlaceholderLint_UnknownToken_FailsWithVocabularyList', () => {
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

    expect(result.message).toBeDefined();
    for (const known of DEFAULT_PLACEHOLDER_VOCABULARY) {
      expect(result.message).toContain(known);
    }
    expect(result.message).toContain('NOT_A_REAL_TOKEN');
  });

  /**
   * The lint reports each unknown token in one pass, with its file and its 1-indexed
   * line. `gamma` holds two unknown tokens on different lines. The token in
   * `references/note.md` must not show, because the lint does not read references.
   */
  it('PlaceholderLint_RunsOnAllSources_AggregatesErrors', () => {
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
    writeFileSync(
      join(sourcesDir, 'gamma', 'SKILL.md'),
      'line 1 {{CHAIN}}\nline 2 {{WIDGET}}\nline 3 {{GADGET}}\n',
    );

    mkdirSync(join(sourcesDir, 'alpha', 'references'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'alpha', 'references', 'note.md'),
      '{{ignored_handlebar}}\n',
    );

    const result = lintPlaceholders({ sourcesDir });

    expect(result.passed).toBe(false);
    const tokens = result.unknownTokens.map((u) => u.token).sort();
    expect(tokens).toEqual(['FOO_BAR', 'GADGET', 'SOMETHING_ELSE', 'WIDGET']);

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

    expect(betaUnknowns[0].line).toBe(2);
    const gammaLines = gammaUnknowns.map((u) => u.line).sort();
    expect(gammaLines).toEqual([2, 3]);

    expect(result.message).toBeDefined();
    expect(result.message).toContain('FOO_BAR');
    expect(result.message).toContain('SOMETHING_ELSE');
    expect(result.message).toContain('WIDGET');
    expect(result.message).toContain('GADGET');
    expect(result.message).not.toContain('ignored_handlebar');
  });

  it('PlaceholderLint_DefaultVocabulary_ContainsCanonicalFiveTokens', () => {
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

/**
 * A raw `mcp__...` reference is deprecated in favor of the `{{CALL ...}}` macro. The
 * lint warns by default, and it fails when `EXARCHOS_LINT_STRICT=1`.
 */
describe('placeholder-lint — task 010 (DR-2/DR-8 mcp__ deprecation)', () => {
  const originalStrict = process.env.EXARCHOS_LINT_STRICT;

  afterEach(() => {
    if (originalStrict === undefined) {
      delete process.env.EXARCHOS_LINT_STRICT;
    } else {
      process.env.EXARCHOS_LINT_STRICT = originalStrict;
    }
  });

  /**
   * With strict mode off, the warning does not fail the lint. The warning carries
   * the matched text, the file and the line.
   */
  it('LintSkillSource_RawMcpPrefix_EmitsDeprecationWarning', () => {
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

    delete process.env.EXARCHOS_LINT_STRICT;

    const result = lintPlaceholders({ sourcesDir });

    expect(result.passed).toBe(true);
    expect(result.deprecationWarnings.length).toBe(1);
    const warning = result.deprecationWarnings[0];
    expect(warning.pattern).toBe(
      'mcp__plugin_exarchos_exarchos__exarchos_workflow',
    );
    expect(warning.file).toMatch(/foo[\\/]SKILL\.md$/);
    expect(warning.line).toBe(2);
    expect(result.message).toContain(
      'mcp__plugin_exarchos_exarchos__exarchos_workflow',
    );
  });

  it('LintSkillSource_CallMacro_NoWarning', () => {
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

/**
 * A source with no orchestration token is a procedural skill. A procedural skill
 * renders once for all runtimes from logical prose, so it must not carry a prefix token.
 */
describe('placeholder-lint — task 002 (collapsed-vocabulary rules)', () => {
  it('lintPlaceholders_PrefixTokenInProceduralSkill_Rejected', () => {
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
    const byToken = new Map(violations.map((v) => [v.token, v]));
    expect(byToken.get('COMMAND_PREFIX')!.line).toBe(1);
    expect(byToken.get('MCP_PREFIX')!.line).toBe(3);
    expect(result.message).toContain('MCP_PREFIX');
    expect(result.message).toContain('COMMAND_PREFIX');
  });

  /**
   * A source with an orchestration token is an orchestration skill. Prefix tokens
   * are also valid there, so a skill with both token kinds has no violation.
   */
  it('lintPlaceholders_OrchestrationTokenInOrchestrationSkill_Allowed', () => {
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

  /**
   * `enforceCollapsedVocabulary` is off by default. When it is off, the
   * collapsed-vocabulary pass does not run.
   */
  it('lintPlaceholders_PrefixTokenInProceduralSkill_NotEnforcedByDefault', () => {
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
  const SKILLS_SRC = join(__dirname, '../../../content');

  /**
   * With collapsed-vocabulary enforcement on, the real `content/` tree has zero
   * violations. The rules use the derived class of each source, so an orchestration
   * skill can keep its prefix tokens. A prefix token in a procedural `SKILL.md`
   * fails this test.
   */
  it('lintPlaceholders_RewrittenProceduralTree_NoPrefixTokens', () => {
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
