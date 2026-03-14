import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleNewProject } from './new-project.js';

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';

const TEMPLATE_CONTENT = `# Project CLAUDE.md

## Build & Test

\`\`\`bash
npm run build
npm run test:run
npm run test:coverage
npm run typecheck
\`\`\`
`;

describe('handleNewProject', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Simulate Claude Code plugin context so auto resolves to claude-code
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '/mock/plugin/root');
    // Default: template exists and is readable
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(TEMPLATE_CONTENT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('FreshProject_CreatesClaudeMdAndSettings', () => {
    // existsSync: template exists, project dir exists, CLAUDE.md does not, settings.json does not, .git does not
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/my-project') return true; // project dir exists
      return false;
    });

    const result = handleNewProject({ projectPath: '/tmp/my-project' });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[]; report: string };
    expect(data.filesCreated).toContain('CLAUDE.md');
    expect(data.filesCreated).toContain('.claude/settings.json');

    // CLAUDE.md was written
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('CLAUDE.md'),
      TEMPLATE_CONTENT,
      'utf-8',
    );

    // settings.json was written
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.claude/settings.json'),
      expect.stringContaining('"permissions"'),
      'utf-8',
    );
  });

  it('ClaudeMdAlreadyExists_Skips', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/existing') return true;
      if (path.endsWith('CLAUDE.md')) return true; // already exists
      return false;
    });

    const result = handleNewProject({ projectPath: '/tmp/existing' });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[]; report: string };
    expect(data.filesCreated).not.toContain('CLAUDE.md');
    // Should not have written CLAUDE.md
    const claudeMdWrites = vi.mocked(writeFileSync).mock.calls.filter(
      (call) => String(call[0]).endsWith('CLAUDE.md'),
    );
    expect(claudeMdWrites).toHaveLength(0);
  });

  it('TypeScriptLanguage_CustomizesCommands', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/ts-project') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/ts-project',
      language: 'typescript',
    });

    expect(result.success).toBe(true);
    // Find the CLAUDE.md write call
    const claudeMdWrite = vi.mocked(writeFileSync).mock.calls.find(
      (call) => String(call[0]).endsWith('CLAUDE.md'),
    );
    expect(claudeMdWrite).toBeDefined();
    const content = String(claudeMdWrite![1]);
    expect(content).toContain('npm run test');
    expect(content).not.toContain('npm run test:run');
    expect(content).toContain('npm run test -- --coverage');
    expect(content).not.toContain('npm run test:coverage');
  });

  it('CSharpLanguage_ReplaceNpmWithDotnet', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/cs-project') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/cs-project',
      language: 'csharp',
    });

    expect(result.success).toBe(true);
    const claudeMdWrite = vi.mocked(writeFileSync).mock.calls.find(
      (call) => String(call[0]).endsWith('CLAUDE.md'),
    );
    expect(claudeMdWrite).toBeDefined();
    const content = String(claudeMdWrite![1]);
    expect(content).toContain('dotnet test');
    expect(content).toContain('dotnet build');
    expect(content).not.toContain('npm run test:run');
    expect(content).not.toContain('npm run typecheck');
  });

  it('MinimalMode_NoClaudeDirectory', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/minimal-project') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/minimal-project',
      minimal: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[] };
    expect(data.filesCreated).not.toContain('.claude/settings.json');

    // Should not create .claude directory
    const mkdirCalls = vi.mocked(mkdirSync).mock.calls.filter(
      (call) => String(call[0]).includes('.claude'),
    );
    expect(mkdirCalls).toHaveLength(0);
  });

  it('ProjectDirDoesNotExist_CreatesIt', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      // Project dir does NOT exist
      return false;
    });

    const result = handleNewProject({ projectPath: '/tmp/new-dir' });

    expect(result.success).toBe(true);
    // mkdirSync should be called for the project directory
    expect(mkdirSync).toHaveBeenCalledWith('/tmp/new-dir', { recursive: true });
  });

  it('GitRepo_AddsToGitignore', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/git-project') return true;
      if (path.endsWith('.git')) return true; // is a git repo
      return false;
    });
    // .gitignore does not contain settings.local.json yet
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('.gitignore')) return '# existing entries\nnode_modules/\n';
      return TEMPLATE_CONTENT;
    });

    const result = handleNewProject({ projectPath: '/tmp/git-project' });

    expect(result.success).toBe(true);
    // appendFileSync should add settings.local.json to .gitignore
    expect(appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.gitignore'),
      expect.stringContaining('settings.local.json'),
    );
  });

  it('GitRepo_GitignoreAlreadyHasEntry_Skips', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/git-project2') return true;
      if (path.endsWith('.git')) return true;
      if (path.endsWith('.gitignore')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('.gitignore')) return 'node_modules/\n.claude/settings.local.json\n';
      return TEMPLATE_CONTENT;
    });

    handleNewProject({ projectPath: '/tmp/git-project2' });

    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it('DefaultProjectPath_UsesCurrentDirectory', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      return true; // everything exists for simplicity
    });

    const result = handleNewProject({});

    expect(result.success).toBe(true);
    // Should use "." which resolves to process.cwd()
    const data = result.data as { projectPath: string };
    expect(data.projectPath).toBe(process.cwd());
  });

  it('TemplateMissing_ReturnsError', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return false;
      if (path === '/tmp/no-template') return true;
      return false;
    });

    const result = handleNewProject({ projectPath: '/tmp/no-template' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TEMPLATE_NOT_FOUND');
  });
});

describe('handleNewProject with platform parameter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default: template exists and is readable
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(TEMPLATE_CONTENT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('handleNewProject_PlatformClaudeCode_CreatesClaudeSettingsJson', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/cc-project') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/cc-project',
      platform: 'claude-code',
    });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[] };
    expect(data.filesCreated).toContain('.claude/settings.json');

    // settings.json was written
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.claude/settings.json'),
      expect.stringContaining('"permissions"'),
      'utf-8',
    );

    // .claude directory was created
    const mkdirCalls = vi.mocked(mkdirSync).mock.calls.filter(
      (call) => String(call[0]).includes('.claude'),
    );
    expect(mkdirCalls.length).toBeGreaterThan(0);
  });

  it('handleNewProject_PlatformClaudeCode_AddsClaudeToGitignore', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/cc-git-project') return true;
      if (path.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('.gitignore')) return '# existing\n';
      return TEMPLATE_CONTENT;
    });

    const result = handleNewProject({
      projectPath: '/tmp/cc-git-project',
      platform: 'claude-code',
    });

    expect(result.success).toBe(true);
    expect(appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.gitignore'),
      expect.stringContaining('settings.local.json'),
    );
  });

  it('handleNewProject_PlatformGeneric_CreatesExarchosYml', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/generic-project') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/generic-project',
      platform: 'generic',
    });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[] };
    expect(data.filesCreated).toContain('.exarchos.yml');

    // .exarchos.yml was written with expected content
    const ymlWrite = vi.mocked(writeFileSync).mock.calls.find(
      (call) => String(call[0]).endsWith('.exarchos.yml'),
    );
    expect(ymlWrite).toBeDefined();
    const content = String(ymlWrite![1]);
    expect(content).toContain('review:');
    expect(content).toContain('dimensions:');
    expect(content).toContain('commit-style: conventional');
  });

  it('handleNewProject_PlatformGeneric_DoesNotCreateClaudeDir', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/generic-no-claude') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/generic-no-claude',
      platform: 'generic',
    });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[] };

    // Should NOT create .claude/ directory or settings.json
    expect(data.filesCreated).not.toContain('.claude/settings.json');
    const mkdirCalls = vi.mocked(mkdirSync).mock.calls.filter(
      (call) => String(call[0]).includes('.claude'),
    );
    expect(mkdirCalls).toHaveLength(0);

    // Should NOT update .gitignore for settings.local.json
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it('handleNewProject_PlatformAuto_WithPluginRoot_ScaffoldsClaudeCode', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/some/plugin/root');

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/auto-claude') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/auto-claude',
      platform: 'auto',
    });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[] };
    expect(data.filesCreated).toContain('.claude/settings.json');
    expect(data.filesCreated).not.toContain('.exarchos.yml');
  });

  it('handleNewProject_PlatformAuto_WithoutPluginRoot_ScaffoldsGeneric', () => {
    // Ensure neither env var is set
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/auto-generic') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/auto-generic',
      platform: 'auto',
    });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[] };
    expect(data.filesCreated).toContain('.exarchos.yml');
    expect(data.filesCreated).not.toContain('.claude/settings.json');
  });

  it('handleNewProject_DefaultPlatform_IsAuto', () => {
    // When no platform is specified, it should behave as 'auto'
    // With no env vars set, auto should resolve to 'generic'
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');

    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/default-platform') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/default-platform',
      // No platform specified — should default to 'auto'
    });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[] };
    // auto without plugin env vars → generic → .exarchos.yml
    expect(data.filesCreated).toContain('.exarchos.yml');
    expect(data.filesCreated).not.toContain('.claude/settings.json');
  });
});
