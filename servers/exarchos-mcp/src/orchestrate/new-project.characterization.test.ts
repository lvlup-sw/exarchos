/**
 * Characterization (golden-master) tests for `handleNewProject()` — DR-9, task 003.
 *
 * These tests PIN the *current* scaffold outputs of the `new-project`
 * orchestrate handler so the onboard/doctor consolidation can prove the
 * post-fold greenfield path (`onboard --new`) reproduces the same artifacts.
 * They are regression oracles, NOT behavioral specs: they assert what the code
 * does today, and must PASS against the current `new-project.ts` unchanged.
 *
 * The headline pin is the `applyLanguageCustomizations` npm→dotnet string
 * rewrite (#1508 residue). Task 017 deletes that rewrite; capturing the EXACT
 * rewritten CLAUDE.md content for a `csharp` (dotnet) target here makes the
 * later deletion provably "equivalence minus the rewrite" — the diff against
 * this golden is exactly the three substituted command lines and nothing else.
 *
 * `node:fs` is fully mocked (mirroring `new-project.test.ts`) so writes are
 * captured in-memory; no real files are created. A representative template
 * containing all three canonical command tokens is injected via `readFileSync`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs — every side effect is captured, none touch disk.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs';
import { handleNewProject } from './new-project.js';

/**
 * Representative CLAUDE.md template containing all three canonical command
 * tokens the rewrite targets (`npm run test:run`, `npm run test:coverage`,
 * `npm run typecheck`) plus an untouched `npm run build` line to prove the
 * rewrite is scoped to exactly those three tokens.
 */
const TEMPLATE_CONTENT = `# Project CLAUDE.md

## Build & Test

\`\`\`bash
npm run build
npm run test:run
npm run test:coverage
npm run typecheck
\`\`\`
`;

/** Helper: find the single writeFileSync call whose target ends with `suffix`. */
function findWrite(suffix: string): [string, string] | undefined {
  const call = vi
    .mocked(writeFileSync)
    .mock.calls.find((c) => String(c[0]).endsWith(suffix));
  if (!call) return undefined;
  return [String(call[0]), String(call[1])];
}

describe('new-project characterization (DR-9, task 003)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Simulate Claude Code plugin context so `auto` resolves to claude-code and
    // the template path resolves under a mock plugin root.
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '/mock/plugin/root');
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

  it('NewProject_Scaffold_PinnedOutputsIncludingLangRewrite', () => {
    // Claude-code platform, csharp (dotnet) language, git repo present so the
    // .gitignore append path runs. This exercises the full scaffold surface:
    //   - project dir mkdir (skipped: dir exists)
    //   - CLAUDE.md (with the dotnet rewrite)
    //   - .claude/ mkdir + settings.json
    //   - .gitignore append
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/char-project') return true; // project dir exists
      if (path.endsWith('.git')) return true; // is a git repo
      return false;
      // NB: CLAUDE.md, .claude/settings.json, .gitignore all absent → created.
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('.gitignore')) return 'node_modules/\n';
      return TEMPLATE_CONTENT;
    });

    const result = handleNewProject({
      projectPath: '/tmp/char-project',
      platform: 'claude-code',
      language: 'csharp',
    });

    // ── PINNED: result envelope ─────────────────────────────────────────────
    expect(result.success).toBe(true);
    const data = result.data as {
      projectPath: string;
      filesCreated: string[];
      report: string;
    };
    expect(data.projectPath).toBe('/tmp/char-project');
    expect(data.filesCreated).toEqual(['CLAUDE.md', '.claude/settings.json']);

    // ── PINNED: CLAUDE.md content AFTER the dotnet rewrite ──────────────────
    // This is the golden master Task 017's deletion is measured against: the
    // three canonical npm tokens become their dotnet scaffold equivalents,
    // every other line is byte-identical to the template.
    const claudeMd = findWrite('CLAUDE.md');
    expect(claudeMd).toBeDefined();
    expect(claudeMd![1]).toBe(`# Project CLAUDE.md

## Build & Test

\`\`\`bash
npm run build
dotnet test
dotnet test --collect:"XPlat Code Coverage"
dotnet build
\`\`\`
`);

    // ── PINNED: .claude/settings.json content (exact bytes) ─────────────────
    const settings = findWrite('.claude/settings.json');
    expect(settings).toBeDefined();
    expect(settings![1]).toBe(
      `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`,
    );

    // ── PINNED: .claude directory is created ────────────────────────────────
    const claudeDirMkdir = vi
      .mocked(mkdirSync)
      .mock.calls.filter((c) => String(c[0]).endsWith('.claude'));
    expect(claudeDirMkdir).toHaveLength(1);

    // ── PINNED: .gitignore append (entry + value) ───────────────────────────
    expect(appendFileSync).toHaveBeenCalledTimes(1);
    const gitignoreCall = vi.mocked(appendFileSync).mock.calls[0];
    expect(String(gitignoreCall[0])).toMatch(/\.gitignore$/);
    // Existing content ends with "\n", so no extra leading newline is prefixed.
    expect(String(gitignoreCall[1])).toBe('.claude/settings.local.json\n');
  });

  it('NewProject_TypeScriptLangRewrite_PinnedClaudeMd', () => {
    // The node (typescript) rewrite is the no-op-looking sibling: test:run →
    // `npm run test`, test:coverage → `npm run test -- --coverage`, typecheck →
    // `npm run typecheck` (unchanged). Pinning it documents the full rewrite
    // table so Task 017's deletion can be checked for both languages.
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/char-ts') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/char-ts',
      platform: 'claude-code',
      language: 'typescript',
    });

    expect(result.success).toBe(true);
    const claudeMd = findWrite('CLAUDE.md');
    expect(claudeMd).toBeDefined();
    expect(claudeMd![1]).toBe(`# Project CLAUDE.md

## Build & Test

\`\`\`bash
npm run build
npm run test
npm run test -- --coverage
npm run typecheck
\`\`\`
`);
  });

  it('NewProject_NoLanguage_ClaudeMdIsTemplateVerbatim', () => {
    // Without a `language`, `applyLanguageCustomizations` never runs and the
    // template is written byte-for-byte. This is the baseline the rewritten
    // variants diverge from.
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/char-nolang') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/char-nolang',
      platform: 'claude-code',
    });

    expect(result.success).toBe(true);
    const claudeMd = findWrite('CLAUDE.md');
    expect(claudeMd).toBeDefined();
    expect(claudeMd![1]).toBe(TEMPLATE_CONTENT);
  });

  it('NewProject_GenericPlatform_PinnedExarchosYml', () => {
    // Generic platform writes `.exarchos.yml` from the template and creates no
    // .claude/ directory. Pin the exact YAML content the consolidation must
    // reproduce.
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/char-generic') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/char-generic',
      platform: 'generic',
    });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[] };
    expect(data.filesCreated).toEqual(['CLAUDE.md', '.exarchos.yml']);

    // ── PINNED: .exarchos.yml content (exact bytes) ─────────────────────────
    const yml = findWrite('.exarchos.yml');
    expect(yml).toBeDefined();
    expect(yml![1]).toBe(`# Exarchos workflow configuration
# See https://lvlup-sw.github.io/exarchos/reference/configuration for options

review:
  dimensions:
    D1: blocking
    D2: blocking
    D3: warning
    D4: warning
    D5: warning

tools:
  commit-style: conventional
`);

    // ── PINNED: no .claude directory mkdir on the generic path ──────────────
    const claudeDirMkdir = vi
      .mocked(mkdirSync)
      .mock.calls.filter((c) => String(c[0]).includes('.claude'));
    expect(claudeDirMkdir).toHaveLength(0);
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it('NewProject_MinimalMode_OnlyClaudeMd', () => {
    // Minimal mode writes CLAUDE.md only — no platform config, no .claude dir.
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('CLAUDE.md.template')) return true;
      if (path === '/tmp/char-minimal') return true;
      return false;
    });

    const result = handleNewProject({
      projectPath: '/tmp/char-minimal',
      platform: 'claude-code',
      minimal: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as { filesCreated: string[] };
    expect(data.filesCreated).toEqual(['CLAUDE.md']);
    expect(findWrite('.claude/settings.json')).toBeUndefined();
    expect(findWrite('.exarchos.yml')).toBeUndefined();
    const claudeDirMkdir = vi
      .mocked(mkdirSync)
      .mock.calls.filter((c) => String(c[0]).includes('.claude'));
    expect(claudeDirMkdir).toHaveLength(0);
  });
});
