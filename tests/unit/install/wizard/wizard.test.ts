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
import { MockPromptAdapter } from '../../../../src/install/wizard/prompts.js';
import { runWizard, runNonInteractive } from '../../../../src/install/wizard/wizard.js';
import type { Manifest } from '../../../../src/install/manifest/types.js';
import type { ExarchosConfig } from '../../../../src/install/operations/config.js';

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
          bundlePath: 'dist/exarchos-mcp.js',
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

/**
 * `MockPromptAdapter` returns its preset responses in order, and it ignores the prompt options.
 * `runWizard` asks for the mode, the optional MCP servers, the optional plugins, the rule sets, and the confirmation, in that order.
 */
describe('runWizard', () => {
  it('returns standard mode selections', async () => {
    const manifest = createTestManifest();
    const prompts = new MockPromptAdapter([
      'standard',
      ['context7'],
      ['serena'],
      ['coding-standards'],
      true,
    ]);

    const result = await runWizard(manifest, prompts);

    expect(result.mode).toBe('standard');
    expect(result.selections.mcpServers).toContain('context7');
    expect(result.selections.mcpServers).toContain('exarchos');
  });

  it('returns dev mode selections', async () => {
    const manifest = createTestManifest();
    const prompts = new MockPromptAdapter([
      'dev',
      ['context7', 'microsoft-learn'],
      ['serena'],
      ['coding-standards', 'pr-descriptions'],
      true,
    ]);

    const result = await runWizard(manifest, prompts);

    expect(result.mode).toBe('dev');
    expect(result.selections.model).toBe('claude-opus-4-6');
  });

  it('always includes required servers regardless of selection', async () => {
    const manifest = createTestManifest();
    const prompts = new MockPromptAdapter([
      'standard',
      [],
      [],
      [],
      true,
    ]);

    const result = await runWizard(manifest, prompts);

    expect(result.selections.mcpServers).toContain('exarchos');
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

  /**
   * The responses repeat the values of `existingConfig`, and the mock ignores the pre-selected options.
   * Thus the asserted mode and servers come from the responses, not from `existingConfig`.
   */
  it('uses existing config as defaults', async () => {
    const manifest = createTestManifest();
    const existingConfig: ExarchosConfig = {
      version: '1.0.0',
      installedAt: '2025-01-01T00:00:00Z',
      mode: 'dev',
      selections: {
        mcpServers: ['context7'],
        plugins: ['serena'],
        ruleSets: ['coding-standards'],
        model: 'claude-sonnet-4-20250514',
      },
      hashes: {},
    };

    const prompts = new MockPromptAdapter([
      'dev',
      ['context7'],
      ['serena'],
      ['coding-standards'],
      true,
    ]);

    const result = await runWizard(manifest, prompts, existingConfig);

    expect(result.mode).toBe('dev');
    expect(result.selections.mcpServers).toContain('context7');
    expect(result.selections.mcpServers).toContain('exarchos');
  });
});

describe('runNonInteractive', () => {
  /** The result holds the required components and the components that the manifest marks as default. */
  it('uses manifest defaults with useDefaults flag', () => {
    const manifest = createTestManifest();

    const result = runNonInteractive(manifest, { useDefaults: true });

    expect(result.mode).toBe('standard');
    expect(result.selections.model).toBe('claude-opus-4-6');
    expect(result.selections.mcpServers).toContain('exarchos');
    expect(result.selections.plugins).toContain('github');
    expect(result.selections.plugins).toContain('serena');
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
        plugins: ['serena'],
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
    expect(result.selections.mcpServers).toContain('exarchos');
    expect(result.selections.plugins).toContain('github');
    expect(result.selections.plugins).toContain('serena');
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
