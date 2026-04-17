import { describe, it, expect } from 'vitest';
import {
  ConfigWriteStatusSchema,
  ConfigWriteResultSchema,
  InitInputSchema,
  InitOutputSchema,
} from './schema.js';

describe('ConfigWriteStatusSchema', () => {
  it('ConfigWriteStatusSchema_ValidValues_ParseSuccessfully', () => {
    for (const val of ['written', 'skipped', 'failed', 'stub'] as const) {
      expect(ConfigWriteStatusSchema.parse(val)).toBe(val);
    }
  });

  it('ConfigWriteStatusSchema_InvalidValue_Throws', () => {
    expect(() => ConfigWriteStatusSchema.parse('unknown')).toThrow();
  });
});

describe('ConfigWriteResultSchema', () => {
  it('ConfigWriteResultSchema_ValidWritten_ParsesSuccessfully', () => {
    const input = {
      runtime: 'claude-code',
      path: '/home/user/.claude.json',
      status: 'written',
      componentsWritten: ['mcp-config'],
    };
    const parsed = ConfigWriteResultSchema.parse(input);
    expect(parsed.status).toBe('written');
    expect(parsed.componentsWritten).toEqual(['mcp-config']);
  });

  it('ConfigWriteResultSchema_FailedWithError_ParsesSuccessfully', () => {
    const input = {
      runtime: 'claude-code',
      path: '/home/user/.claude.json',
      status: 'failed',
      componentsWritten: [],
      error: 'Permission denied',
    };
    const parsed = ConfigWriteResultSchema.parse(input);
    expect(parsed.status).toBe('failed');
    expect(parsed.error).toBe('Permission denied');
  });

  it('ConfigWriteResultSchema_FailedWithoutError_ThrowsRefinementError', () => {
    const input = {
      runtime: 'claude-code',
      path: '/home/user/.claude.json',
      status: 'failed',
      componentsWritten: [],
    };
    expect(() => ConfigWriteResultSchema.parse(input)).toThrow(/error/i);
  });

  it('ConfigWriteResultSchema_EmptyRuntime_Throws', () => {
    const input = {
      runtime: '',
      path: '/home/user/.claude.json',
      status: 'written',
      componentsWritten: [],
    };
    expect(() => ConfigWriteResultSchema.parse(input)).toThrow();
  });

  it('ConfigWriteResultSchema_EmptyPath_Throws', () => {
    const input = {
      runtime: 'claude-code',
      path: '',
      status: 'written',
      componentsWritten: [],
    };
    expect(() => ConfigWriteResultSchema.parse(input)).toThrow();
  });

  it('ConfigWriteResultSchema_MissingPath_ParsesSuccessfully', () => {
    const input = {
      runtime: 'cursor',
      status: 'written',
      componentsWritten: ['mcp-config'],
    };
    const parsed = ConfigWriteResultSchema.parse(input);
    expect(parsed.path).toBeUndefined();
  });

  it('ConfigWriteResultSchema_WithWarnings_ParsesSuccessfully', () => {
    const input = {
      runtime: 'claude-code',
      path: '/home/user/.claude.json',
      status: 'written',
      componentsWritten: ['mcp-config'],
      warnings: ['Existing config backed up'],
    };
    const parsed = ConfigWriteResultSchema.parse(input);
    expect(parsed.warnings).toEqual(['Existing config backed up']);
  });

  it('ConfigWriteResultSchema_SkippedWithoutError_ParsesSuccessfully', () => {
    const input = {
      runtime: 'cursor',
      path: '/proj/.cursor/mcp.json',
      status: 'skipped',
      componentsWritten: [],
    };
    const parsed = ConfigWriteResultSchema.parse(input);
    expect(parsed.status).toBe('skipped');
    expect(parsed.error).toBeUndefined();
  });
});

describe('InitInputSchema', () => {
  it('InitInputSchema_EmptyObject_AppliesDefaults', () => {
    const parsed = InitInputSchema.parse({});
    expect(parsed.nonInteractive).toBe(false);
    expect(parsed.forceOverwrite).toBe(false);
    expect(parsed.format).toBe('table');
    expect(parsed.runtime).toBeUndefined();
    expect(parsed.vcs).toBeUndefined();
  });

  it('InitInputSchema_AllFieldsSet_ParsesSuccessfully', () => {
    const input = {
      runtime: 'claude-code',
      vcs: 'git',
      nonInteractive: true,
      forceOverwrite: true,
      format: 'json',
    };
    const parsed = InitInputSchema.parse(input);
    expect(parsed.runtime).toBe('claude-code');
    expect(parsed.format).toBe('json');
  });

  it('InitInputSchema_InvalidFormat_Throws', () => {
    expect(() =>
      InitInputSchema.parse({ format: 'yaml' }),
    ).toThrow();
  });
});

describe('InitOutputSchema', () => {
  it('InitOutputSchema_ValidOutput_ParsesSuccessfully', () => {
    const input = {
      runtimes: [
        {
          runtime: 'claude-code',
          path: '/home/user/.claude.json',
          status: 'written',
          componentsWritten: ['mcp-config'],
        },
      ],
      vcs: {
        provider: 'git',
        remoteUrl: 'https://github.com/user/repo',
        cliAvailable: true,
        cliVersion: '2.43.0',
      },
      durationMs: 150,
    };
    const parsed = InitOutputSchema.parse(input);
    expect(parsed.runtimes).toHaveLength(1);
    expect(parsed.vcs?.provider).toBe('git');
    expect(parsed.durationMs).toBe(150);
  });

  it('InitOutputSchema_NullVcs_ParsesSuccessfully', () => {
    const input = {
      runtimes: [],
      vcs: null,
      durationMs: 50,
    };
    const parsed = InitOutputSchema.parse(input);
    expect(parsed.vcs).toBeNull();
  });

  it('InitOutputSchema_NegativeDuration_Throws', () => {
    const input = {
      runtimes: [],
      vcs: null,
      durationMs: -1,
    };
    expect(() => InitOutputSchema.parse(input)).toThrow();
  });

  it('InitOutputSchema_NonIntegerDuration_Throws', () => {
    const input = {
      runtimes: [],
      vcs: null,
      durationMs: 1.5,
    };
    expect(() => InitOutputSchema.parse(input)).toThrow();
  });

  it('InitOutputSchema_FailedRuntimeWithoutError_Throws', () => {
    const input = {
      runtimes: [
        {
          runtime: 'claude-code',
          path: '/home/user/.claude.json',
          status: 'failed',
          componentsWritten: [],
          // Missing error — should fail refinement
        },
      ],
      vcs: null,
      durationMs: 100,
    };
    expect(() => InitOutputSchema.parse(input)).toThrow(/error/i);
  });
});
