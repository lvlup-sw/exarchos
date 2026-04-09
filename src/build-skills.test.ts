/**
 * Tests for the platform-agnostic skills renderer / build CLI.
 *
 * Structure by task:
 *   - Task 003: render() placeholder substitution core
 *   - Task 004: render() error handling + assertNoUnresolvedPlaceholders
 *   - Task 005: parseTokenArgs + argument-aware substitution
 *   - Task 006: copyReferences
 *   - Task 007: buildAllSkills orchestrator + escape hatch
 */

import { describe, it, expect } from 'vitest';
import {
  render,
  assertNoUnresolvedPlaceholders,
  parseTokenArgs,
} from './build-skills.js';

describe('render — task 003: placeholder substitution core', () => {
  it('Render_SimpleToken_SubstitutesValue', () => {
    const body = 'Hello {{NAME}}';
    const out = render(body, { NAME: 'world' });
    expect(out).toBe('Hello world');
  });

  it('Render_MultipleTokens_SubstitutesAll', () => {
    const body = '{{GREETING}}, {{NAME}}!';
    const out = render(body, { GREETING: 'Hi', NAME: 'Ada' });
    expect(out).toBe('Hi, Ada!');
  });

  it('Render_RepeatedToken_SubstitutesAllOccurrences', () => {
    const body = '{{X}} and {{X}} and {{X}}';
    const out = render(body, { X: 'foo' });
    expect(out).toBe('foo and foo and foo');
  });

  it('Render_MultiLineValue_PreservesIndentation', () => {
    // Opening token at column 4 — every subsequent line of the multi-line
    // substitution must be prefixed with 4 spaces so the visual indentation
    // of the rendered block is preserved.
    const body = '    {{BLOCK}}';
    const placeholders = { BLOCK: 'line 1\nline 2\nline 3' };
    const out = render(body, placeholders);
    expect(out).toBe('    line 1\n    line 2\n    line 3');
  });

  it('Render_NoTokens_ReturnsInputUnchanged', () => {
    const body = 'plain text with no placeholders at all';
    const out = render(body, { UNUSED: 'nope' });
    expect(out).toBe(body);
  });

  it('Render_TokenWithSurroundingText_OnlyReplacesToken', () => {
    const body = 'before {{TOKEN}} after';
    const out = render(body, { TOKEN: 'MIDDLE' });
    expect(out).toBe('before MIDDLE after');
  });

  it('Render_Idempotent_SecondRunProducesIdenticalOutput', () => {
    const body = 'a {{X}} b {{Y}} c';
    const placeholders = { X: '1', Y: '2' };
    const first = render(body, placeholders);
    const second = render(first, placeholders);
    // Byte-for-byte identical: idempotence.
    expect(second).toBe(first);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });
});

describe('render — task 004: error handling', () => {
  it('Render_UnknownPlaceholder_ThrowsWithTokenNameAndLineNumber', () => {
    const body = 'line 1\nline 2 with {{NOPE}}\nline 3';
    const placeholders = { X: 'x' };
    expect(() =>
      render(body, placeholders, { sourcePath: 'skills-src/foo/SKILL.md', runtimeName: 'claude' }),
    ).toThrowError(/\{\{NOPE\}\}/);
    expect(() =>
      render(body, placeholders, { sourcePath: 'skills-src/foo/SKILL.md', runtimeName: 'claude' }),
    ).toThrowError(/skills-src\/foo\/SKILL\.md:2/);
  });

  it('Render_UnknownPlaceholder_ErrorListsKnownTokens', () => {
    const body = '{{UNKNOWN}}';
    const placeholders = { ZEBRA: 'z', APPLE: 'a', MANGO: 'm' };
    let err: Error | undefined;
    try {
      render(body, placeholders, { sourcePath: 'x.md', runtimeName: 'claude' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // Alphabetically sorted: APPLE, MANGO, ZEBRA
    expect(err!.message).toContain('APPLE, MANGO, ZEBRA');
    expect(err!.message).toContain('runtimes/claude.yaml');
  });

  it('Render_UnresolvedPostRender_ThrowsViaAssert', () => {
    // Residual braces after render: assertNoUnresolvedPlaceholders should
    // flag them. Here we construct dirty output directly.
    const rendered = 'line1\nline2 has {{LEFTOVER}}\nline3';
    expect(() =>
      assertNoUnresolvedPlaceholders(rendered, 'skills/foo/SKILL.md', 'claude'),
    ).toThrow(/\{\{LEFTOVER\}\}/);
  });

  it('AssertNoUnresolvedPlaceholders_CleanInput_DoesNotThrow', () => {
    const clean = 'hello world\nno placeholders here';
    expect(() => assertNoUnresolvedPlaceholders(clean, 'x.md', 'claude')).not.toThrow();
  });

  it('AssertNoUnresolvedPlaceholders_ResidualBraces_ThrowsWithLocation', () => {
    const dirty = 'a\nb\nc\n{{STILL_HERE}}';
    let err: Error | undefined;
    try {
      assertNoUnresolvedPlaceholders(dirty, 'skills/foo/SKILL.md', 'claude');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('STILL_HERE');
    expect(err!.message).toContain('skills/foo/SKILL.md:4');
  });
});

describe('parseTokenArgs + argument-aware render — task 005', () => {
  it('ParseTokenArgs_NoArgs_ReturnsEmptyMap', () => {
    expect(parseTokenArgs('')).toEqual({});
  });

  it('ParseTokenArgs_SingleArg_ReturnsOneEntry', () => {
    expect(parseTokenArgs('next="plan"')).toEqual({ next: 'plan' });
  });

  it('ParseTokenArgs_MultipleArgs_ReturnsAll', () => {
    expect(parseTokenArgs('next="plan" args="$PLAN" mode="fast"')).toEqual({
      next: 'plan',
      args: '$PLAN',
      mode: 'fast',
    });
  });

  it('ParseTokenArgs_ArgWithSpaces_QuotedCorrectly', () => {
    expect(parseTokenArgs('next="plan file" args="--help"')).toEqual({
      next: 'plan file',
      args: '--help',
    });
  });

  it('ParseTokenArgs_MalformedArg_ThrowsWithContext', () => {
    // Missing closing quote — should throw with context about the broken input.
    expect(() => parseTokenArgs('next="plan')).toThrow(/malformed|unterminated|quote/i);
  });

  it('Render_ChainTokenWithArgs_SubstitutesPlaceholderVariables', () => {
    const body = '{{CHAIN next="plan" args="$PLAN"}}';
    const placeholders = { CHAIN: 'run {{next}} with {{args}}' };
    const out = render(body, placeholders);
    expect(out).toBe('run plan with $PLAN');
  });

  it('Render_ChainTokenWithArgs_ClaudeVariant_ExpandsToSkillCall', () => {
    const body = '{{CHAIN next="plan" args="$PLAN"}}';
    const placeholders = {
      CHAIN: 'Skill({ skill: "exarchos:{{next}}", args: "{{args}}" })',
    };
    const out = render(body, placeholders);
    expect(out).toBe('Skill({ skill: "exarchos:plan", args: "$PLAN" })');
  });

  it('Render_ChainTokenWithArgs_GenericVariant_ExpandsToProseInstruction', () => {
    const body = '{{CHAIN next="plan" args="$PLAN"}}';
    const placeholders = {
      CHAIN: 'Next, invoke the `{{next}}` skill with arguments: {{args}}',
    };
    const out = render(body, placeholders);
    expect(out).toBe('Next, invoke the `plan` skill with arguments: $PLAN');
  });
});
