import { describe, it, expect } from 'vitest';
import { parseArgs } from './cli.js';

describe('CLI Arg Parsing', () => {
  it('parseArgs_NoFlags_ReturnsInteractiveDefaults', () => {
    const args = parseArgs([]);
    expect(args.interactive).toBe(true);
    expect(args.env).toBeUndefined();
    expect(args.companions.exclude).toEqual([]);
  });

  it('parseArgs_YesFlag_ReturnsNonInteractive', () => {
    const args = parseArgs(['--yes']);
    expect(args.interactive).toBe(false);
  });

  it('parseArgs_YFlag_ReturnsNonInteractive', () => {
    const args = parseArgs(['-y']);
    expect(args.interactive).toBe(false);
  });

  it('parseArgs_EnvClaudeCode_SetsEnvironment', () => {
    const args = parseArgs(['--env', 'claude-code']);
    expect(args.env).toBe('claude-code');
  });

  it('parseArgs_EnvCopilotCli_SetsEnvironment', () => {
    const args = parseArgs(['--env', 'copilot-cli']);
    expect(args.env).toBe('copilot-cli');
  });

  it('parseArgs_EnvCursor_SetsEnvironment', () => {
    const args = parseArgs(['--env', 'cursor']);
    expect(args.env).toBe('cursor');
  });

  it('parseArgs_InvalidEnv_Throws', () => {
    expect(() => parseArgs(['--env', 'invalid'])).toThrow();
  });

  it('parseArgs_NoAxiomFlag_AddsToExclude', () => {
    const args = parseArgs(['--no-axiom']);
    expect(args.companions.exclude).toContain('axiom');
  });

  it('parseArgs_NoImpeccableFlag_AddsToExclude', () => {
    const args = parseArgs(['--no-impeccable']);
    expect(args.companions.exclude).toContain('impeccable');
  });

  it('parseArgs_MultipleNoFlags_AddsAllToExclude', () => {
    const args = parseArgs(['--no-axiom', '--no-serena']);
    expect(args.companions.exclude).toContain('axiom');
    expect(args.companions.exclude).toContain('serena');
  });
});
