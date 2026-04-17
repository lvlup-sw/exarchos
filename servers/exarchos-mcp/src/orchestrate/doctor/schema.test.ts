import { describe, it, expect } from 'vitest';
import {
  CheckResultSchema,
  DoctorOutputSchema,
} from './schema.js';

describe('CheckResultSchema', () => {
  it('CheckResultSchema_ValidPass_ParsesSuccessfully', () => {
    const input = {
      category: 'runtime',
      name: 'node-version',
      status: 'Pass',
      message: 'Node.js 20.11.0 detected.',
      durationMs: 4,
    };

    const parsed = CheckResultSchema.parse(input);

    expect(parsed.status).toBe('Pass');
    expect(parsed.name).toBe('node-version');
    expect(parsed.durationMs).toBe(4);
  });

  it('CheckResultSchema_MissingCategory_ThrowsValidationError', () => {
    const input = {
      name: 'node-version',
      status: 'Pass',
      message: 'Node.js 20.11.0 detected.',
      durationMs: 4,
    };

    expect(() => CheckResultSchema.parse(input)).toThrow();
  });

  it('CheckResultSchema_SkippedWithoutReason_ThrowsValidationError', () => {
    const input = {
      category: 'remote',
      name: 'remote-mcp-stub',
      status: 'Skipped',
      message: 'Remote MCP not configured.',
      durationMs: 0,
    };

    expect(() => CheckResultSchema.parse(input)).toThrow(/reason/i);
  });

  it('CheckResultSchema_FailWithFix_ParsesSuccessfully', () => {
    const input = {
      category: 'runtime',
      name: 'node-version',
      status: 'Fail',
      message: 'Node.js 18.17.0 detected. Exarchos requires Node.js >= 20.',
      fix: 'Upgrade Node via nvm install 20 or your package manager',
      durationMs: 6,
    };

    const parsed = CheckResultSchema.parse(input);

    expect(parsed.status).toBe('Fail');
    expect(parsed.fix).toContain('nvm install 20');
  });
});

describe('DoctorOutputSchema', () => {
  it('DoctorOutputSchema_SummaryMismatchesChecksLength_ThrowsValidationError', () => {
    const input = {
      checks: [
        {
          category: 'runtime',
          name: 'node-version',
          status: 'Pass',
          message: 'Node.js 20.11.0 detected.',
          durationMs: 4,
        },
      ],
      summary: {
        passed: 2,
        warnings: 0,
        failed: 0,
        skipped: 0,
      },
    };

    expect(() => DoctorOutputSchema.parse(input)).toThrow(/summary/i);
  });
});
