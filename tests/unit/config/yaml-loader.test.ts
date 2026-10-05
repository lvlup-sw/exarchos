import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';
import { toPosix } from '../../../src/utils/paths.js';

describe('loadProjectConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-loader-'));
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  it('loadProjectConfig_NoFile_ReturnsEmptyConfig', async () => {
    const { loadProjectConfig } = await import('../../../src/config/yaml-loader.js');
    const result = loadProjectConfig(tmpDir);
    expect(result).toEqual({});
  });

  it('loadProjectConfig_ValidYaml_ParsesAllSections', async () => {
    const { loadProjectConfig } = await import('../../../src/config/yaml-loader.js');
    const yaml = `
review:
  dimensions:
    D1: blocking
    D3: warning
  gates:
    security-scan:
      enabled: true
      blocking: true
  routing:
    coderabbit-threshold: 0.6
    risk-weights:
      security-path: 0.30
      api-surface: 0.20
      diff-complexity: 0.15
      new-files: 0.10
      infra-config: 0.15
      cross-module: 0.10
vcs:
  provider: github
  settings:
    auto-merge-strategy: squash
workflow:
  skip-phases:
    - plan-review
  max-fix-cycles: 2
  phases:
    synthesize:
      human-checkpoint: false
tools:
  default-branch: main
  commit-style: conventional
  auto-merge: true
  pr-strategy: github-native
hooks:
  on:
    workflow.transition:
      - command: echo test
        timeout: 5000
`;
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yml'), yaml, 'utf-8');
    const result = loadProjectConfig(tmpDir);
    expect(result.review?.dimensions?.D1).toBe('blocking');
    expect(result.review?.dimensions?.D3).toBe('warning');
    expect(result.review?.gates?.['security-scan']?.enabled).toBe(true);
    expect(result.review?.routing?.['coderabbit-threshold']).toBe(0.6);
    expect(result.vcs?.provider).toBe('github');
    expect(result.workflow?.['skip-phases']).toEqual(['plan-review']);
    expect(result.workflow?.['max-fix-cycles']).toBe(2);
    expect(result.tools?.['default-branch']).toBe('main');
    expect(result.tools?.['commit-style']).toBe('conventional');
    expect(result.hooks?.on?.['workflow.transition']).toHaveLength(1);
  });

  it('loadProjectConfig_YmlExtension_Loaded', async () => {
    const { loadProjectConfig } = await import('../../../src/config/yaml-loader.js');
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yml'), 'vcs:\n  provider: github\n', 'utf-8');
    const result = loadProjectConfig(tmpDir);
    expect(result.vcs?.provider).toBe('github');
  });

  it('loadProjectConfig_YamlExtension_Loaded', async () => {
    const { loadProjectConfig } = await import('../../../src/config/yaml-loader.js');
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yaml'), 'vcs:\n  provider: gitlab\n', 'utf-8');
    const result = loadProjectConfig(tmpDir);
    expect(result.vcs?.provider).toBe('gitlab');
  });

  it('loadProjectConfig_MalformedYaml_ReturnsEmptyConfig', async () => {
    const { loadProjectConfig } = await import('../../../src/config/yaml-loader.js');
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yml'), '{{{{invalid yaml: [[[', 'utf-8');
    const result = loadProjectConfig(tmpDir);
    expect(result).toEqual({});
  });

  /**
   * The unknown top-level key `foo` fails strict validation. The loader then parses each section
   * alone and keeps the valid `vcs` section.
   * The warning goes to the structured logger, and this test does not assert it.
   */
  it('loadProjectConfig_InvalidSchema_ReturnsPartialWithWarnings', async () => {
    const { loadProjectConfig } = await import('../../../src/config/yaml-loader.js');
    const yaml = `
vcs:
  provider: github
foo: bar
`;
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yml'), yaml, 'utf-8');
    const result = loadProjectConfig(tmpDir);
    expect(result.vcs?.provider).toBe('github');
  });
});

describe('discoverProjectRoot', () => {
  let tmpDir: string;
  const originalEnv = process.env.EXARCHOS_PROJECT_ROOT;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-root-'));
    delete process.env.EXARCHOS_PROJECT_ROOT;
  });

  afterEach(() => {
    rmrf(tmpDir);
    if (originalEnv !== undefined) {
      process.env.EXARCHOS_PROJECT_ROOT = originalEnv;
    } else {
      delete process.env.EXARCHOS_PROJECT_ROOT;
    }
  });

  it('discoverProjectRoot_EnvVar_TakesPrecedence', async () => {
    const { discoverProjectRoot } = await import('../../../src/config/yaml-loader.js');
    process.env.EXARCHOS_PROJECT_ROOT = '/custom/project/root';
    const result = discoverProjectRoot(tmpDir);
    expect(result).toBe('/custom/project/root');
  });

  it('discoverProjectRoot_WalksUpForYml_FindsRoot', async () => {
    const { discoverProjectRoot } = await import('../../../src/config/yaml-loader.js');
    const childDir = path.join(tmpDir, 'src', 'deep');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yml'), 'vcs:\n  provider: github\n', 'utf-8');
    const result = discoverProjectRoot(childDir);
    expect(result).toBe(tmpDir);
  });

  /**
   * The test does not run on Windows. There, `mkdtemp` gives an 8.3 short name and git gives the
   * long name, and `realpathSync` does not reconcile them. Only this path comparison fails there.
   * Git returns the real path with forward slashes, so the expectation uses `realpathSync` and `toPosix`.
   */
  it.skipIf(process.platform === 'win32')('discoverProjectRoot_FallsBackToGitRoot', async () => {
    const { discoverProjectRoot } = await import('../../../src/config/yaml-loader.js');
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-git-'));
    try {
      await execFileAsync('git', ['init'], { cwd: gitDir });
      const childDir = path.join(gitDir, 'src');
      fs.mkdirSync(childDir, { recursive: true });
      const result = discoverProjectRoot(childDir);
      expect(result).toBe(toPosix(fs.realpathSync(gitDir)));
    } finally {
      rmrf(gitDir);
    }
  });

  /** The test assumes that no ancestor of the OS temp directory holds a config file or a git repository. */
  it('discoverProjectRoot_NothingFound_UsesCwd', async () => {
    const { discoverProjectRoot } = await import('../../../src/config/yaml-loader.js');
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-isolated-'));
    try {
      const result = discoverProjectRoot(isolatedDir);
      expect(result).toBe(isolatedDir);
    } finally {
      rmrf(isolatedDir);
    }
  });

  /**
   * Two readers with `.strict()` schemas read `.exarchos.yml`. The loader validates against the
   * merged schema. A key of the other reader, such as the top-level `mutation`, must not degrade the
   * file to section parsing.
   */
  describe('reconciled full-config validation', () => {
    /**
     * `checkpoint` is not in the `SECTION_KEYS` fallback list, so it survives only when full
     * validation passes. The fallback also recovers `agents`, so `agents` alone proves nothing.
     * The `mutation` key of the other reader must not be in the project slice.
     */
    it('loadProjectConfig_ForeignReaderKey_ValidatesWithoutDegrading', async () => {
      const { loadProjectConfig } = await import('../../../src/config/yaml-loader.js');
      fs.writeFileSync(
        path.join(tmpDir, '.exarchos.yml'),
        [
          'mutation: node scripts/stryker-adapter.mjs',
          'agents:',
          '  default-model: opus',
          'checkpoint:',
          "  operation-threshold: 7",
        ].join('\n'),
        'utf-8',
      );

      const config = loadProjectConfig(tmpDir);

      expect(config.checkpoint?.['operation-threshold']).toBe(7);
      expect(config.agents?.['default-model']).toBe('opus');
      expect(config).not.toHaveProperty('mutation');
    });

    /**
     * An unknown key must still fail full validation. The loader then falls back to section parsing:
     * `agents` survives and the typo does not.
     */
    it('loadProjectConfig_GenuineTypo_StillRejected', async () => {
      const { loadProjectConfig } = await import('../../../src/config/yaml-loader.js');
      fs.writeFileSync(
        path.join(tmpDir, '.exarchos.yml'),
        ['nonsenseKey: 1', 'agents:', '  default-model: opus'].join('\n'),
        'utf-8',
      );

      const config = loadProjectConfig(tmpDir);

      expect(config.agents?.['default-model']).toBe('opus');
      expect(config).not.toHaveProperty('nonsenseKey');
    });

    /**
     * The committed config of this repository must pass full validation. `invariants` is not in the
     * `SECTION_KEYS` fallback list, so its presence proves that.
     */
    it('loadProjectConfig_RepoOwnConfig_ValidatesCleanly', async () => {
      const { loadProjectConfig } = await import('../../../src/config/yaml-loader.js');
      const repoRoot = path.resolve(__dirname, '../../..');
      const config = loadProjectConfig(repoRoot);
      expect(config.agents).toBeDefined();
      expect(config.invariants).toBeDefined();
    });
  });
});
