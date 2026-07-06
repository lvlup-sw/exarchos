/**
 * Characterization (golden-master) tests for `installSkills()` — DR-9, task 003.
 *
 * These tests PIN the *current* observable outputs of the `install-skills`
 * entry point so the onboard/doctor consolidation (DR-1–DR-8) can prove the
 * post-fold `onboard` reproduces the same writes. They are regression oracles,
 * NOT behavioral specs: they assert what the code does today, not what it ought
 * to do. They must PASS against the current `install-skills.ts` with no source
 * changes.
 *
 * Two surfaces are pinned (Feathers characterization, per the design's
 * "guard the fold" baseline):
 *   1. The skills-dir local-copy targets — which runtime skill directories get
 *      written, and to which expanded destination path. `copyLocalSkills()`
 *      mkdir's the real destination root itself (it does not route the mkdir
 *      through the injected `copyDir`), so a freshly-created temp dir stands in
 *      for `$HOME`; the per-skill copy is still captured via an injected
 *      `copyDir` recorder rather than a real recursive copy.
 *   2. The `registerExarchosInClaudeJson()` write shape — the exact JSON object
 *      merged into `~/.claude.json`.
 *
 * Absolute paths (the injected home dir) are normalized to a stable `<HOME>`
 * token so the golden values are environment-independent.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimeMap } from './runtimes/types.js';
import {
  installSkills,
  registerExarchosInClaudeJson,
  type SpawnResult,
} from './install-skills.js';

// ─── Fixtures & helpers ─────────────────────────────────────────────────────

/** Create a fresh, writable temp dir to stand in for `$HOME`. */
function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-char-home-'));
}

/**
 * Build a normalizer that replaces every occurrence of `home` with a stable
 * `<HOME>` token so the pinned golden values do not depend on the absolute
 * temp/home path.
 */
function homeNormalizer(home: string): (value: string) => string {
  return (value: string) => value.split(home).join('<HOME>');
}

/**
 * Minimal valid runtime map factory (mirrors the unit-test factory). Overrides
 * vary only the field under characterization.
 */
function makeRuntime(overrides: Partial<RuntimeMap> = {}): RuntimeMap {
  return {
    name: 'claude',
    capabilities: {
      hasSubagents: true,
      hasSlashCommands: true,
      hasSkillChaining: true,
      mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
    },
    skillsInstallPath: '~/.claude/skills',
    detection: {
      binaries: ['claude'],
      envVars: ['CLAUDE_CODE_SESSION'],
    },
    placeholders: {},
    ...overrides,
  };
}

/** Fake spawn — the local-copy fast path never spawns, but the dep is required. */
function fakeSpawn(): (cmd: string, args: string[]) => Promise<SpawnResult> {
  return vi.fn(async (): Promise<SpawnResult> => ({ code: 0, stderr: '' }));
}

/**
 * Build a temporary `skills/` source tree with a per-runtime subtree
 * `<root>/<runtime>/<skill>/SKILL.md`. Returns the source root and a disposer.
 * Only the source tree touches disk; the copy destinations are captured via
 * injected recorders, never written.
 */
function makeSkillsSource(
  runtimeName: string,
  skills: string[],
): { skillsSource: string; dispose: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-char-skills-'));
  const skillsSource = path.join(tmp, 'skills');
  for (const skill of skills) {
    const dir = path.join(skillsSource, runtimeName, skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${skill}\n`, 'utf8');
  }
  return {
    skillsSource,
    dispose: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('install-skills characterization (DR-9, task 003)', () => {
  it('InstallSkills_LocalCopyAndRegister_PinnedWrites', async () => {
    // Two skills in a claude source tree; the copy must target the expanded
    // skillsInstallPath, one copyDir call per skill subdir, and (for claude)
    // exactly one MCP registration against the home dir.
    const home = makeTmpHome();
    const normalizeHome = homeNormalizer(home);
    const { skillsSource, dispose } = makeSkillsSource('claude', [
      'beta-skill',
      'alpha-skill',
    ]);

    // copyDir recorder: pins which source skill dir → which dest dir.
    const copyDirCalls: Array<{ src: string; dest: string }> = [];
    const copyDir = (src: string, dest: string): void => {
      copyDirCalls.push({
        src: normalizeHome(src.slice(skillsSource.length)), // relative-to-source
        dest: normalizeHome(dest),
      });
    };

    // registerMcp recorder: pins that claude triggers exactly one registration
    // and the home dir it receives.
    const registerCalls: string[] = [];
    const registerMcp = (h: string): void => {
      registerCalls.push(normalizeHome(h));
    };

    try {
      await installSkills({
        agent: 'claude',
        runtimes: [makeRuntime()],
        spawn: fakeSpawn(),
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource,
        copyDir,
        registerMcp,
        // Pin the exercised branch independent of the CI runner's actual OS:
        // this test is about the per-runtime copy/register contract, not the
        // win32-vs-POSIX canonical-dir placement strategy (INV-16, covered by
        // its own `installSkills_Win32_UsesCopyNotSymlink` test). A `symlink`
        // no-op keeps the non-win32 canonical placement branch from invoking
        // the real `fs.symlinkSync` (which needs elevated privileges on an
        // actual Windows host, irrespective of this override).
        platform: 'linux',
        symlink: () => {},
      });
    } finally {
      dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }

    // ── PINNED: local-copy targets ──────────────────────────────────────────
    // One copyDir call per skill, each from `/<runtime>/<skill>` (relative to
    // the source root) to `<HOME>/.claude/skills/<skill>`. Order follows the
    // readdir enumeration; sort the captured pairs to make the golden stable.
    const sortedCopies = [...copyDirCalls].sort((a, b) =>
      a.dest.localeCompare(b.dest),
    );
    expect(sortedCopies).toEqual([
      {
        src: `${path.sep}claude${path.sep}alpha-skill`,
        dest: `<HOME>${path.sep}.claude${path.sep}skills${path.sep}alpha-skill`,
      },
      {
        src: `${path.sep}claude${path.sep}beta-skill`,
        dest: `<HOME>${path.sep}.claude${path.sep}skills${path.sep}beta-skill`,
      },
    ]);

    // ── PINNED: MCP registration is invoked once for claude with the home ───
    expect(registerCalls).toEqual(['<HOME>']);
  });

  it('InstallSkills_LocalCopyNonClaude_DoesNotRegisterMcp', async () => {
    // Non-claude runtimes copy skills but MUST NOT register the MCP server.
    // Pinning this guards the consolidation against accidentally widening the
    // MCP-registration trigger beyond the claude runtime.
    const home = makeTmpHome();
    const normalizeHome = homeNormalizer(home);
    const { skillsSource, dispose } = makeSkillsSource('codex', ['only-skill']);

    const copyDirCalls: Array<{ src: string; dest: string }> = [];
    const copyDir = (src: string, dest: string): void => {
      copyDirCalls.push({
        src: normalizeHome(src.slice(skillsSource.length)),
        dest: normalizeHome(dest),
      });
    };
    const registerCalls: string[] = [];
    const registerMcp = (h: string): void => {
      registerCalls.push(h);
    };

    try {
      await installSkills({
        agent: 'codex',
        runtimes: [
          makeRuntime({
            name: 'codex',
            skillsInstallPath: '~/.codex/skills',
            detection: { binaries: ['codex'], envVars: [] },
          }),
        ],
        spawn: fakeSpawn(),
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource,
        copyDir,
        registerMcp,
        // See the pinned-writes test above: pin the exercised branch
        // independent of the CI runner's actual OS.
        platform: 'linux',
        symlink: () => {},
      });
    } finally {
      dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }

    expect(copyDirCalls).toEqual([
      {
        src: `${path.sep}codex${path.sep}only-skill`,
        dest: `<HOME>${path.sep}.codex${path.sep}skills${path.sep}only-skill`,
      },
    ]);
    // PINNED: no MCP registration for a non-claude runtime.
    expect(registerCalls).toEqual([]);
  });

  it('RegisterExarchosInClaudeJson_FreshHome_PinnedJsonShape', () => {
    // Pin the exact bytes `registerExarchosInClaudeJson` writes into a fresh
    // `~/.claude.json`. This is the MCP-registration write `install-skills`
    // performs for the claude runtime; the consolidation must reproduce it
    // verbatim (modulo home-path normalization).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-char-cj-'));
    try {
      registerExarchosInClaudeJson(home);
      const raw = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
      // `raw` is JSON TEXT: any backslash in `home` (a native Windows path) is
      // doubled by JSON.stringify, so a plain `raw.split(home)` never matches
      // on win32 — escape `home` to its JSON-serialized form before splitting.
      const normalized = raw.split(home.replace(/\\/g, '\\\\')).join('<HOME>');

      // PINNED: the full serialized file content (2-space indent + trailing \n).
      const expected =
        JSON.stringify(
          {
            mcpServers: {
              exarchos: {
                type: 'stdio',
                command: 'exarchos',
                args: ['mcp'],
                env: {
                  WORKFLOW_STATE_DIR: path.join(
                    '<HOME>',
                    '.claude',
                    'workflow-state',
                  ),
                },
              },
            },
          },
          null,
          2,
        ) + '\n';

      expect(normalized).toBe(expected);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('RegisterExarchosInClaudeJson_ExistingConfig_MergesPreservingOthers', () => {
    // Pin the merge shape: existing top-level keys and sibling mcpServers
    // entries are preserved; only `mcpServers.exarchos` is (re)written.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-char-cj2-'));
    try {
      const existing = {
        numberOfStartups: 7,
        mcpServers: {
          'user-thing': { type: 'stdio', command: 'whatever' },
        },
      };
      fs.writeFileSync(
        path.join(home, '.claude.json'),
        JSON.stringify(existing, null, 2),
        'utf8',
      );

      registerExarchosInClaudeJson(home);

      const parsed = JSON.parse(
        fs.readFileSync(path.join(home, '.claude.json'), 'utf8'),
      ) as Record<string, unknown>;
      const mcp = parsed.mcpServers as Record<string, unknown>;

      // PINNED: pre-existing top-level key preserved.
      expect(parsed.numberOfStartups).toBe(7);
      // PINNED: sibling MCP server preserved untouched.
      expect(mcp['user-thing']).toEqual({ type: 'stdio', command: 'whatever' });
      // PINNED: exarchos entry shape.
      expect(mcp.exarchos).toEqual({
        type: 'stdio',
        command: 'exarchos',
        args: ['mcp'],
        env: {
          WORKFLOW_STATE_DIR: path.join(home, '.claude', 'workflow-state'),
        },
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
