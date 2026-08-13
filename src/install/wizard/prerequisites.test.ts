/**
 * Tests for prerequisite detection and runtime checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import {
  detectRuntime,
  getVersion,
  meetsMinVersion,
  checkPrerequisite,
  checkAllPrerequisites,
  DEFAULT_PREREQUISITES,
} from './prerequisites.js';

import type { Prerequisite } from './prerequisites.js';

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectRuntime', () => {
  it('returns node when node is available', () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('20.11.0\n'));

    const result = detectRuntime();

    expect(result).toBe('node');
    expect(mockExecSync).toHaveBeenCalledWith('node --version', { stdio: 'pipe' });
  });

  it('returns bun when only bun is available', () => {
    mockExecSync
      .mockImplementationOnce(() => { throw new Error('not found'); }) // node fails
      .mockReturnValueOnce(Buffer.from('1.3.4\n')); // bun succeeds

    const result = detectRuntime();

    expect(result).toBe('bun');
  });

  it('throws when neither runtime is available', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    expect(() => detectRuntime()).toThrow();
  });
});

describe('getVersion', () => {
  it('parses valid version output', () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('1.3.4\n'));

    const result = getVersion('bun', ['--version']);

    expect(result).toBe('1.3.4');
  });

  it('returns null for invalid output', () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('not-a-version'));

    const result = getVersion('bun', ['--version']);

    expect(result).toBeNull();
  });

  it('returns null when command fails', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    const result = getVersion('missing-cmd', ['--version']);

    expect(result).toBeNull();
  });
});

describe('meetsMinVersion', () => {
  it('returns true when actual is above minimum', () => {
    expect(meetsMinVersion('1.3.4', '1.0.0')).toBe(true);
  });

  it('returns false when actual is below minimum', () => {
    expect(meetsMinVersion('0.9.0', '1.0.0')).toBe(false);
  });

  it('returns true when versions are equal', () => {
    expect(meetsMinVersion('1.0.0', '1.0.0')).toBe(true);
  });

  it('compares minor versions correctly', () => {
    expect(meetsMinVersion('1.2.0', '1.3.0')).toBe(false);
    expect(meetsMinVersion('1.4.0', '1.3.0')).toBe(true);
  });

  it('compares patch versions correctly', () => {
    expect(meetsMinVersion('1.0.1', '1.0.2')).toBe(false);
    expect(meetsMinVersion('1.0.3', '1.0.2')).toBe(true);
  });
});

describe('checkPrerequisite', () => {
  it('returns found when command exists', () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('1.5.0\n'));

    const prereq: Prerequisite = {
      command: 'bun',
      args: ['--version'],
      required: true,
      installHint: 'curl -fsSL https://bun.sh/install | bash',
    };

    const result = checkPrerequisite(prereq);

    expect(result.found).toBe(true);
    expect(result.command).toBe('bun');
  });

  it('returns not found when command is missing', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    const prereq: Prerequisite = {
      command: 'missing-tool',
      args: ['--version'],
      required: true,
      installHint: 'install it',
    };

    const result = checkPrerequisite(prereq);

    expect(result.found).toBe(false);
    expect(result.meetsMinVersion).toBe(false);
    expect(result.installHint).toBe('install it');
  });

  it('includes version when command exists', () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('2.1.3\n'));

    const prereq: Prerequisite = {
      command: 'some-tool',
      args: ['--version'],
      required: true,
      minVersion: '1.0.0',
      installHint: 'install some-tool',
    };

    const result = checkPrerequisite(prereq);

    expect(result.found).toBe(true);
    expect(result.version).toBe('2.1.3');
    expect(result.meetsMinVersion).toBe(true);
  });

  it('returns version too low when below minimum', () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('0.5.0\n'));

    const prereq: Prerequisite = {
      command: 'bun',
      args: ['--version'],
      required: true,
      minVersion: '1.0.0',
      installHint: 'curl -fsSL https://bun.sh/install | bash',
    };

    const result = checkPrerequisite(prereq);

    expect(result.found).toBe(true);
    expect(result.version).toBe('0.5.0');
    expect(result.meetsMinVersion).toBe(false);
  });
});

describe('checkAllPrerequisites', () => {
  it('returns all found when all prerequisites are present', () => {
    // Each checkPrerequisite call invokes getVersion which calls execSync once
    mockExecSync
      .mockReturnValueOnce(Buffer.from('1.5.0\n')) // bun
      .mockReturnValueOnce(Buffer.from('2.0.0\n')); // some-tool

    const prereqs: Prerequisite[] = [
      { command: 'bun', args: ['--version'], required: true, minVersion: '1.0.0', installHint: 'install bun' },
      { command: 'some-tool', args: ['--version'], required: true, installHint: 'install some-tool' },
    ];

    const report = checkAllPrerequisites(prereqs);

    expect(report.results).toHaveLength(2);
    expect(report.results.every((r) => r.found)).toBe(true);
    expect(report.canProceed).toBe(true);
    expect(report.blockers).toHaveLength(0);
  });

  it('blocks install when a required prerequisite is missing', () => {
    mockExecSync
      .mockImplementationOnce(() => { throw new Error('not found'); }) // bun missing
      .mockReturnValueOnce(Buffer.from('2.0.0\n')); // some-tool found

    const prereqs: Prerequisite[] = [
      { command: 'bun', args: ['--version'], required: true, minVersion: '1.0.0', installHint: 'install bun' },
      { command: 'some-tool', args: ['--version'], required: true, installHint: 'install some-tool' },
    ];

    const report = checkAllPrerequisites(prereqs);

    expect(report.canProceed).toBe(false);
    expect(report.blockers.length).toBeGreaterThan(0);
    expect(report.blockers[0]).toContain('bun');
  });

  it('warns but continues when optional prerequisite is missing', () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from('1.5.0\n')) // bun found
      .mockImplementationOnce(() => { throw new Error('not found'); }); // node missing (optional)

    const prereqs: Prerequisite[] = [
      { command: 'bun', args: ['--version'], required: true, minVersion: '1.0.0', installHint: 'install bun' },
      { command: 'node', args: ['--version'], required: false, minVersion: '20.0.0', installHint: 'install node' },
    ];

    const report = checkAllPrerequisites(prereqs);

    expect(report.canProceed).toBe(true);
    expect(report.blockers).toHaveLength(0);
    expect(report.results[1].found).toBe(false);
  });

  it('returns structured report with all results', () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from('1.5.0\n'))
      .mockReturnValueOnce(Buffer.from('0.5.0\n'))
      .mockImplementationOnce(() => { throw new Error('not found'); });

    const prereqs: Prerequisite[] = [
      { command: 'bun', args: ['--version'], required: true, minVersion: '1.0.0', installHint: 'install bun' },
      { command: 'some-tool', args: ['--version'], required: true, minVersion: '1.0.0', installHint: 'install some-tool' },
      { command: 'node', args: ['--version'], required: false, minVersion: '20.0.0', installHint: 'install node' },
    ];

    const report = checkAllPrerequisites(prereqs);

    expect(report.results).toHaveLength(3);
    expect(report.results[0].found).toBe(true);
    expect(report.results[0].meetsMinVersion).toBe(true);
    expect(report.results[1].found).toBe(true);
    expect(report.results[1].meetsMinVersion).toBe(false);
    // some-tool is required but below min version → blocks
    expect(report.canProceed).toBe(false);
    expect(report.blockers.length).toBeGreaterThan(0);
  });
});

describe('DEFAULT_PREREQUISITES', () => {
  it('includes node and bun entries', () => {
    expect(DEFAULT_PREREQUISITES).toHaveLength(2);
    expect(DEFAULT_PREREQUISITES.map((p) => p.command)).toEqual(['node', 'bun']);
  });

  it('marks both node and bun as required', () => {
    const node = DEFAULT_PREREQUISITES.find((p) => p.command === 'node');
    const bun = DEFAULT_PREREQUISITES.find((p) => p.command === 'bun');

    expect(node?.required).toBe(true);
    expect(bun?.required).toBe(true);
  });
});
