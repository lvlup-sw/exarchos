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
