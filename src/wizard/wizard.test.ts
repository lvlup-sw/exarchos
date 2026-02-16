/**
 * Tests for the interactive wizard flow and non-interactive mode.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

import * as fs from 'node:fs';
import { MockPromptAdapter } from './prompts.js';
import { runWizard, runNonInteractive } from './wizard.js';
import type { Manifest } from '../manifest/types.js';
import type { ExarchosConfig } from '../operations/config.js';

const mockReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

/** Minimal test manifest for wizard tests. */
function createTestManifest(): Manifest {
  return {
    version: '2.0.0',
    components: {
      core: [],
      mcpServers: [
        {
          id: 'exarchos',
          name: 'Exarchos',
          description: 'Core workflow server',
          required: true,
          type: 'bundled',
          bundlePath: 'plugins/exarchos',
        },
        {
          id: 'context7',
          name: 'Context7',
          description: 'Library docs',
          required: false,
          type: 'remote',
          url: 'https://example.com',
        },
        {
          id: 'microsoft-learn',
          name: 'Microsoft Learn',
          description: 'MS docs',
          required: false,
          type: 'remote',
          url: 'https://example.com',
        },
      ],
      plugins: [
        {
          id: 'github',
          name: 'GitHub',
          description: 'GitHub integration',
          required: true,
          default: true,
        },
        {
          id: 'serena',
          name: 'Serena',
          description: 'Semantic code analysis',
          required: false,
          default: true,
        },
        {
          id: 'graphite',
          name: 'Graphite',
          description: 'Stacked PRs',
          required: false,
          default: false,
        },
      ],
      ruleSets: [
        {
          id: 'coding-standards',
          name: 'Coding Standards',
          description: 'Coding standards and TDD rules',
          files: ['coding-standards.md', 'tdd.md'],
          default: true,
        },
        {
          id: 'pr-descriptions',
          name: 'PR Descriptions',
          description: 'PR description guidelines',
          files: ['pr-descriptions.md'],
          default: false,
        },
      ],
    },
    defaults: {
      model: 'claude-opus-4-6',
      mode: 'standard',
    },
  };
}

describe('runWizard', () => {
  it('returns standard mode selections', async () => {
    const manifest = createTestManifest();
    // Responses: mode, mcpServers, plugins, ruleSets, confirm
    const prompts = new MockPromptAdapter([
      'standard',                          // mode
      ['context7'],                         // optional mcpServers
      ['serena'],                           // optional plugins
      ['coding-standards'],                  // ruleSets
      true,                                 // confirm
    ]);

    const result = await runWizard(manifest, prompts);

    expect(result.mode).toBe('standard');
    expect(result.selections.mcpServers).toContain('context7');
    // Required server always included
    expect(result.selections.mcpServers).toContain('exarchos');
  });

  it('returns dev mode selections', async () => {
    const manifest = createTestManifest();
    const prompts = new MockPromptAdapter([
      'dev',                                // mode
      ['context7', 'microsoft-learn'],      // optional mcpServers
      ['serena', 'graphite'],               // optional plugins
      ['coding-standards', 'pr-descriptions'], // ruleSets
      true,                                 // confirm
    ]);

    const result = await runWizard(manifest, prompts);

    expect(result.mode).toBe('dev');
    expect(result.selections.model).toBe('claude-opus-4-6');
  });

  it('always includes required servers regardless of selection', async () => {
    const manifest = createTestManifest();
    // User selects no optional servers
    const prompts = new MockPromptAdapter([
      'standard',                           // mode
      [],                                   // no optional mcpServers selected
      [],                                   // no optional plugins
      [],                                   // no ruleSets
      true,                                 // confirm
    ]);

    const result = await runWizard(manifest, prompts);

    // Required server 'exarchos' must still be included
    expect(result.selections.mcpServers).toContain('exarchos');
    // Required plugin 'github' must still be included
    expect(result.selections.plugins).toContain('github');
  });

  it('returns selected rule set file list', async () => {
    const manifest = createTestManifest();
    const prompts = new MockPromptAdapter([
      'standard',
      [],
      [],
      ['coding-standards', 'pr-descriptions'],
      true,
    ]);

    const result = await runWizard(manifest, prompts);

    expect(result.selections.ruleSets).toContain('coding-standards');
    expect(result.selections.ruleSets).toContain('pr-descriptions');
  });

  it('uses manifest default model', async () => {
    const manifest = createTestManifest();
    const prompts = new MockPromptAdapter([
      'standard',
      [],
      [],
      [],
      true,
    ]);

    const result = await runWizard(manifest, prompts);

    expect(result.selections.model).toBe('claude-opus-4-6');
  });

  it('uses existing config as defaults', async () => {
    const manifest = createTestManifest();
    const existingConfig: ExarchosConfig = {
      version: '1.0.0',
      installedAt: '2025-01-01T00:00:00Z',
      mode: 'dev',
      selections: {
        mcpServers: ['context7'],
        plugins: ['serena', 'graphite'],
        ruleSets: ['coding-standards'],
        model: 'claude-sonnet-4-20250514',
      },
      hashes: {},
    };

    // Wizard should use existing config as defaults
    // User accepts all defaults by selecting same values
    const prompts = new MockPromptAdapter([
      'dev',
      ['context7'],
      ['serena', 'graphite'],
      ['coding-standards'],
      true,
    ]);

    const result = await runWizard(manifest, prompts, existingConfig);

    expect(result.mode).toBe('dev');
    expect(result.selections.mcpServers).toContain('context7');
    expect(result.selections.mcpServers).toContain('exarchos'); // required always included
  });
});

describe('runNonInteractive', () => {
  it('uses manifest defaults with useDefaults flag', () => {
    const manifest = createTestManifest();

    const result = runNonInteractive(manifest, { useDefaults: true });

    expect(result.mode).toBe('standard');
    expect(result.selections.model).toBe('claude-opus-4-6');
    // Required servers always included
    expect(result.selections.mcpServers).toContain('exarchos');
    // Required plugins always included
    expect(result.selections.plugins).toContain('github');
    // Default plugins included
    expect(result.selections.plugins).toContain('serena');
    // Default rule sets included
    expect(result.selections.ruleSets).toContain('coding-standards');
  });

  it('uses previous selections with useDefaults and existing config', () => {
    const manifest = createTestManifest();
    const existingConfig: ExarchosConfig = {
      version: '1.0.0',
      installedAt: '2025-01-01T00:00:00Z',
      mode: 'dev',
      selections: {
        mcpServers: ['context7'],
        plugins: ['graphite'],
        ruleSets: ['pr-descriptions'],
        model: 'claude-sonnet-4-20250514',
      },
      hashes: {},
    };

    const result = runNonInteractive(manifest, {
      useDefaults: true,
      existingConfig,
    });

    expect(result.mode).toBe('dev');
    expect(result.selections.model).toBe('claude-sonnet-4-20250514');
    expect(result.selections.mcpServers).toContain('context7');
    expect(result.selections.mcpServers).toContain('exarchos'); // required always included
    expect(result.selections.plugins).toContain('github'); // required always included
    expect(result.selections.plugins).toContain('graphite');
    expect(result.selections.ruleSets).toContain('pr-descriptions');
  });

  it('uses config file when configPath is provided', () => {
    const manifest = createTestManifest();

    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({
        version: '1.0.0',
        installedAt: '2025-01-01T00:00:00Z',
        mode: 'dev',
        selections: {
          mcpServers: ['microsoft-learn'],
          plugins: ['serena'],
          ruleSets: ['tdd'],
          model: 'claude-opus-4-6',
        },
        hashes: {},
      }),
    );

    const result = runNonInteractive(manifest, {
      configPath: '/tmp/test-config.json',
    });

    expect(result.mode).toBe('dev');
    expect(result.selections.mcpServers).toContain('microsoft-learn');
    expect(result.selections.mcpServers).toContain('exarchos');
    expect(result.selections.plugins).toContain('serena');
    expect(result.selections.plugins).toContain('github');
    expect(result.selections.ruleSets).toContain('tdd');
  });

  it('throws for invalid config file', () => {
    const manifest = createTestManifest();

    mockReadFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    expect(() => runNonInteractive(manifest, {
      configPath: '/tmp/nonexistent.json',
    })).toThrow();
  });
});
