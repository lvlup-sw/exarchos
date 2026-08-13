/**
 * Tests for display formatting helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  formatHeader,
  formatPrerequisiteReport,
  formatInstallSummary,
  formatProgressLine,
} from './display.js';
import type { PrerequisiteReport } from './prerequisites.js';
import type { InstallResult } from './display.js';

describe('formatHeader', () => {
  it('returns a formatted banner with title and version', () => {
    const result = formatHeader('Exarchos', '2.0.0');

    expect(result).toContain('Exarchos');
    expect(result).toContain('2.0.0');
    expect(result).toContain('=');
  });
});

describe('formatPrerequisiteReport', () => {
  it('shows checkmarks when all prerequisites are found', () => {
    const report: PrerequisiteReport = {
      results: [
        { command: 'bun', found: true, version: '1.5.0', meetsMinVersion: true, installHint: '' },
        { command: 'gt', found: true, version: '2.0.0', meetsMinVersion: true, installHint: '' },
      ],
      canProceed: true,
      blockers: [],
    };

    const result = formatPrerequisiteReport(report);

    expect(result).toContain('bun');
    expect(result).toContain('1.5.0');
    // Should have a check mark for found items
    expect(result).toMatch(/[✓]/);
  });

  it('shows errors for missing required prerequisites', () => {
    const report: PrerequisiteReport = {
      results: [
        { command: 'bun', found: false, meetsMinVersion: false, installHint: 'curl -fsSL https://bun.sh/install | bash' },
        { command: 'gt', found: true, version: '2.0.0', meetsMinVersion: true, installHint: '' },
      ],
      canProceed: false,
      blockers: ["Required tool 'bun' not found. Install: curl -fsSL https://bun.sh/install | bash"],
    };

    const result = formatPrerequisiteReport(report);

    expect(result).toContain('bun');
    // Should have an error indicator for missing items
    expect(result).toMatch(/[✗]/);
    expect(result).toContain('curl');
  });
});

describe('formatInstallSummary', () => {
  it('returns a formatted summary of install results', () => {
    const results: InstallResult[] = [
      { label: 'Commands', status: 'done' },
      { label: 'Skills', status: 'done' },
      { label: 'Rules', status: 'skip', detail: 'No rule sets selected' },
      { label: 'MCP Server', status: 'fail', detail: 'Build failed' },
    ];

    const result = formatInstallSummary(results);

    expect(result).toContain('Commands');
    expect(result).toContain('Skills');
    expect(result).toContain('Rules');
    expect(result).toContain('MCP Server');
    expect(result).toContain('No rule sets selected');
    expect(result).toContain('Build failed');
  });
});

describe('formatProgressLine', () => {
  it('returns checkmark for completed items', () => {
    const result = formatProgressLine('Commands', 'done');

    expect(result).toContain('✓');
    expect(result).toContain('Commands');
  });

  it('returns cross for failed items', () => {
    const result = formatProgressLine('MCP Server', 'fail', 'Build error');

    expect(result).toContain('✗');
    expect(result).toContain('MCP Server');
    expect(result).toContain('Build error');
  });

  it('returns tilde for skipped items', () => {
    const result = formatProgressLine('Rules', 'skip', 'Not selected');

    expect(result).toContain('~');
    expect(result).toContain('Rules');
    expect(result).toContain('Not selected');
  });

  it('includes detail when provided', () => {
    const result = formatProgressLine('Plugins', 'done', '3 installed');

    expect(result).toContain('✓');
    expect(result).toContain('Plugins');
    expect(result).toContain('3 installed');
  });
});
