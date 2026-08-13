import { describe, it, expect } from 'vitest';
import { tokenizeCommand, splitCommand } from './tokenize-command.js';

describe('tokenizeCommand', () => {
  it('SimpleCommand_SplitsOnWhitespace', () => {
    expect(tokenizeCommand('npm run test:run')).toEqual(['npm', 'run', 'test:run']);
  });

  it('SingleToken_ReturnsSingleElement', () => {
    expect(tokenizeCommand('pytest')).toEqual(['pytest']);
  });

  it('Empty_ReturnsEmpty', () => {
    expect(tokenizeCommand('')).toEqual([]);
    expect(tokenizeCommand('   ')).toEqual([]);
  });

  it('DoubleQuotes_PreserveSpaces', () => {
    expect(tokenizeCommand('pytest -k "slow api"')).toEqual(['pytest', '-k', 'slow api']);
  });

  it('SingleQuotes_PreserveSpaces', () => {
    expect(tokenizeCommand("pytest -k 'slow api'")).toEqual(['pytest', '-k', 'slow api']);
  });

  it('SingleQuotes_DoNotProcessBackslash', () => {
    // In single quotes, a backslash is literal (POSIX shell behavior).
    expect(tokenizeCommand("echo 'a\\b'")).toEqual(['echo', 'a\\b']);
  });

  it('Backslash_EscapesNextChar', () => {
    expect(tokenizeCommand('echo a\\ b')).toEqual(['echo', 'a b']);
    expect(tokenizeCommand('echo "she said \\"hi\\""')).toEqual(['echo', 'she said "hi"']);
  });

  it('PathWithSpaces_QuotedExecutable', () => {
    expect(tokenizeCommand('"./bin/custom runner" --flag')).toEqual([
      './bin/custom runner',
      '--flag',
    ]);
  });

  it('UnterminatedDoubleQuote_Throws', () => {
    expect(() => tokenizeCommand('echo "open')).toThrow(/unterminated quote/);
  });

  it('UnterminatedSingleQuote_Throws', () => {
    expect(() => tokenizeCommand("echo 'open")).toThrow(/unterminated quote/);
  });

  it('TrailingBackslash_Throws', () => {
    expect(() => tokenizeCommand('echo \\')).toThrow(/trailing backslash/);
  });

  it('MultipleSpaces_CollapseAsSeparators', () => {
    expect(tokenizeCommand('npm   run    test:run')).toEqual(['npm', 'run', 'test:run']);
  });

  it('AdjacentQuoteAndText_FormSingleToken', () => {
    // Standard shell behavior: `--flag="value"` becomes one token.
    expect(tokenizeCommand('--flag="value with space"')).toEqual([
      '--flag=value with space',
    ]);
  });
});

describe('splitCommand', () => {
  it('ReturnsCmdAndArgs', () => {
    const { cmd, args } = splitCommand('npm run test:run');
    expect(cmd).toBe('npm');
    expect(args).toEqual(['run', 'test:run']);
  });

  it('EmptyInput_ReturnsEmptyCmd', () => {
    const { cmd, args } = splitCommand('');
    expect(cmd).toBe('');
    expect(args).toEqual([]);
  });

  it('QuotedArgs_PreservedInArgs', () => {
    const { cmd, args } = splitCommand('pytest -k "not slow"');
    expect(cmd).toBe('pytest');
    expect(args).toEqual(['-k', 'not slow']);
  });
});
