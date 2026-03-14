import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('loadProjectConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-loader-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadProjectConfig_NoFile_ReturnsEmptyConfig', async () => {
    const { loadProjectConfig } = await import('./yaml-loader.js');
    const result = loadProjectConfig(tmpDir);
    expect(result).toEqual({});
  });

  it('loadProjectConfig_ValidYaml_ParsesAllSections', async () => {
    const { loadProjectConfig } = await import('./yaml-loader.js');
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
    const { loadProjectConfig } = await import('./yaml-loader.js');
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yml'), 'vcs:\n  provider: github\n', 'utf-8');
    const result = loadProjectConfig(tmpDir);
    expect(result.vcs?.provider).toBe('github');
  });

  it('loadProjectConfig_YamlExtension_Loaded', async () => {
    const { loadProjectConfig } = await import('./yaml-loader.js');
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yaml'), 'vcs:\n  provider: gitlab\n', 'utf-8');
    const result = loadProjectConfig(tmpDir);
    expect(result.vcs?.provider).toBe('gitlab');
  });

  it('loadProjectConfig_MalformedYaml_ReturnsEmptyConfig', async () => {
    const { loadProjectConfig } = await import('./yaml-loader.js');
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yml'), '{{{{invalid yaml: [[[', 'utf-8');
    const result = loadProjectConfig(tmpDir);
    expect(result).toEqual({});
  });

  it('loadProjectConfig_InvalidSchema_ReturnsPartialWithWarnings', async () => {
    const { loadProjectConfig } = await import('./yaml-loader.js');
    // 'foo' is an unknown top-level key (strict mode rejects it)
    // But valid sections should be returned via partial parsing
    const yaml = `
vcs:
  provider: github
foo: bar
`;
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yml'), yaml, 'utf-8');
    // loadProjectConfig logs warnings via structured logger (pino) — not console
    const result = loadProjectConfig(tmpDir);
    // When schema validation fails, we attempt section-level parse
    // The valid vcs section should be preserved
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env.EXARCHOS_PROJECT_ROOT = originalEnv;
    } else {
      delete process.env.EXARCHOS_PROJECT_ROOT;
    }
  });

  it('discoverProjectRoot_EnvVar_TakesPrecedence', async () => {
    const { discoverProjectRoot } = await import('./yaml-loader.js');
    process.env.EXARCHOS_PROJECT_ROOT = '/custom/project/root';
    const result = discoverProjectRoot(tmpDir);
    expect(result).toBe('/custom/project/root');
  });

  it('discoverProjectRoot_WalksUpForYml_FindsRoot', async () => {
    const { discoverProjectRoot } = await import('./yaml-loader.js');
    // Create a nested dir structure with config in parent
    const childDir = path.join(tmpDir, 'src', 'deep');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.exarchos.yml'), 'vcs:\n  provider: github\n', 'utf-8');
    const result = discoverProjectRoot(childDir);
    expect(result).toBe(tmpDir);
  });

  it('discoverProjectRoot_FallsBackToGitRoot', async () => {
    const { discoverProjectRoot } = await import('./yaml-loader.js');
    // Create a temp git repo without .exarchos.yml
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-git-'));
    try {
      const { execSync } = await import('node:child_process');
      execSync('git init', { cwd: gitDir, stdio: 'ignore' });
      const childDir = path.join(gitDir, 'src');
      fs.mkdirSync(childDir, { recursive: true });
      const result = discoverProjectRoot(childDir);
      expect(result).toBe(gitDir);
    } finally {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it('discoverProjectRoot_NothingFound_UsesCwd', async () => {
    const { discoverProjectRoot } = await import('./yaml-loader.js');
    // Use /tmp itself — no config file, no git root (most likely)
    // Create an isolated dir that is NOT a git repo
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-isolated-'));
    try {
      const result = discoverProjectRoot(isolatedDir);
      expect(result).toBe(isolatedDir);
    } finally {
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
