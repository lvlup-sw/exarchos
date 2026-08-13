/**
 * Tests for canonical-name command alias emission (T2, v2.10.1 Bundle A, #1472).
 *
 * The emitter renders one thin "alias" command file per `COMMAND_TO_SKILL`
 * entry, but ONLY for runtimes that declare the `canonicalCommandAliases`
 * capability. Today that is opencode alone; cursor/generic/codex/copilot
 * declare no such capability and must receive ZERO alias files (INV-4: the
 * gate is a declared per-runtime capability, never a hardcoded "opencode"
 * literal).
 *
 * These tests consume the REAL `COMMAND_TO_SKILL` map and the REAL command
 * files, writing into a temp output dir so they assert the production
 * behavior end-to-end.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildCommandAliases, emitCommandAliases } from './build-command-aliases.js';
import { COMMAND_TO_SKILL } from './config/canonical-skills.js';
import { loadRuntime } from './runtimes/load.js';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const REPO_RUNTIMES_DIR = join(REPO_ROOT, 'runtimes');
const REPO_COMMANDS_DIR = join(REPO_ROOT, 'commands');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aliases-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

const COMMAND_KEYS = Object.keys(COMMAND_TO_SKILL).sort();

describe('buildCommandAliases — capability gating', () => {
  it('emits one alias file per COMMAND_TO_SKILL entry for opencode (has capability)', () => {
    const opencode = loadRuntime(join(REPO_RUNTIMES_DIR, 'opencode.yaml'));
    const outDir = makeTempDir();

    const report = buildCommandAliases({
      runtimes: [opencode],
      commandsDir: REPO_COMMANDS_DIR,
      outDir,
    });

    expect(report.filesWritten).toBe(COMMAND_KEYS.length);

    const aliasDir = join(outDir, 'opencode');
    const emitted = readdirSync(aliasDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(emitted).toEqual(COMMAND_KEYS);
  });

  it('emits ZERO files for a runtime without the capability (cursor)', () => {
    const cursor = loadRuntime(join(REPO_RUNTIMES_DIR, 'cursor.yaml'));
    const outDir = makeTempDir();

    const report = buildCommandAliases({
      runtimes: [cursor],
      commandsDir: REPO_COMMANDS_DIR,
      outDir,
    });

    expect(report.filesWritten).toBe(0);
    expect(existsSync(join(outDir, 'cursor'))).toBe(false);
  });

  it.each(['generic', 'codex', 'copilot', 'cursor'])(
    'emits ZERO files for %s (no canonicalCommandAliases capability)',
    (name) => {
      const rt = loadRuntime(join(REPO_RUNTIMES_DIR, `${name}.yaml`));
      const outDir = makeTempDir();

      const report = buildCommandAliases({
        runtimes: [rt],
        commandsDir: REPO_COMMANDS_DIR,
        outDir,
      });

      expect(report.filesWritten).toBe(0);
      expect(existsSync(join(outDir, name))).toBe(false);
    },
  );

  it('only emits for the capable runtimes in a mixed batch', () => {
    const runtimes = ['generic', 'opencode', 'cursor', 'codex'].map((n) =>
      loadRuntime(join(REPO_RUNTIMES_DIR, `${n}.yaml`)),
    );
    const outDir = makeTempDir();

    buildCommandAliases({ runtimes, commandsDir: REPO_COMMANDS_DIR, outDir });

    expect(existsSync(join(outDir, 'opencode'))).toBe(true);
    expect(existsSync(join(outDir, 'generic'))).toBe(false);
    expect(existsSync(join(outDir, 'cursor'))).toBe(false);
    expect(existsSync(join(outDir, 'codex'))).toBe(false);
  });
});

describe('emitCommandAliases — stale cleanup across all runtimes', () => {
  // loadAllRuntimes requires every runtime map present, so write all six;
  // only opencode's `canonicalCommandAliases` is toggled by `opencodeEnabled`.
  function writeToggleRuntimes(runtimesDir: string, opencodeEnabled: boolean): void {
    mkdirSync(runtimesDir, { recursive: true });
    const names = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
    for (const name of names) {
      const enabled = name === 'opencode' ? opencodeEnabled : false;
      writeFileSync(
        join(runtimesDir, `${name}.yaml`),
        [
          `name: ${name}`,
          'preferredFacade: cli',
          'capabilities:',
          '  hasSubagents: true',
          '  hasSlashCommands: true',
          '  hasSkillChaining: false',
          `  mcpPrefix: "mcp__${name}__"`,
          `  canonicalCommandAliases: ${enabled}`,
          `skillsInstallPath: "~/.${name}/skills"`,
          ...(name === 'opencode'
            ? ['commandsInstallPath: "~/.config/opencode/commands"']
            : []),
          'detection:',
          '  binaries: []',
          '  envVars: []',
          'placeholders:',
          `  MCP_PREFIX: "mcp__${name}__"`,
          '  COMMAND_PREFIX: "/"',
          '  TASK_TOOL: "Task"',
          '  CHAIN: "[invoke {{next}} with {{args}}]"',
          "  SPAWN_AGENT_CALL: 'Task({ prompt: \"{{prompt}}\" })'",
          '  SUBAGENT_COMPLETION_HOOK: "inline"',
          '  SUBAGENT_RESULT_API: "inline"',
          '',
        ].join('\n'),
      );
    }
  }

  it('prunes a runtime alias tree after canonicalCommandAliases is disabled', () => {
    const runtimesDir = makeTempDir();
    const outDir = makeTempDir();

    // First pass: capability ON → full alias tree emitted.
    writeToggleRuntimes(runtimesDir, true);
    emitCommandAliases({ runtimesDir, commandsDir: REPO_COMMANDS_DIR, outDir });
    const aliasDir = join(outDir, 'opencode');
    expect(
      readdirSync(aliasDir).filter((f) => f.endsWith('.md')).length,
    ).toBe(COMMAND_KEYS.length);

    // Second pass: capability OFF → the now-orphaned tree must be pruned,
    // even though the runtime no longer emits (regression guard for the
    // cleanup-only-emitting-runtimes bug).
    writeToggleRuntimes(runtimesDir, false);
    emitCommandAliases({ runtimesDir, commandsDir: REPO_COMMANDS_DIR, outDir });
    const remaining = existsSync(aliasDir)
      ? readdirSync(aliasDir).filter((f) => f.endsWith('.md'))
      : [];
    expect(remaining).toEqual([]);
  });
});

describe('buildCommandAliases — alias file shape', () => {
  function emitOpencode(): string {
    const opencode = loadRuntime(join(REPO_RUNTIMES_DIR, 'opencode.yaml'));
    const outDir = makeTempDir();
    buildCommandAliases({
      runtimes: [opencode],
      commandsDir: REPO_COMMANDS_DIR,
      outDir,
    });
    return join(outDir, 'opencode');
  }

  it('lifts the description from the command frontmatter', () => {
    const aliasDir = emitOpencode();
    const ideate = readFileSync(join(aliasDir, 'ideate.md'), 'utf8');
    // commands/ideate.md frontmatter:
    //   description: Start collaborative design exploration for a feature or problem
    const cmdSrc = readFileSync(join(REPO_COMMANDS_DIR, 'ideate.md'), 'utf8');
    const cmdDesc = cmdSrc.match(/^description:\s*(.+)$/m)?.[1].trim();
    expect(cmdDesc).toBeTruthy();
    expect(ideate).toMatch(/^---\n/);
    const aliasDesc = ideate.match(/^description:\s*(.+)$/m)?.[1].trim();
    expect(aliasDesc).toBe(cmdDesc);
  });

  it('body references the single mapped skill and passes $ARGUMENTS', () => {
    const aliasDir = emitOpencode();
    const ideate = readFileSync(join(aliasDir, 'ideate.md'), 'utf8');
    // ideate → ideate (identity-collapsed skill name)
    expect(ideate).toContain('`ideate`');
    expect(ideate).toContain('$ARGUMENTS');
  });

  it('multi-skill commands name every mapped skill in order (review)', () => {
    const aliasDir = emitOpencode();
    const review = readFileSync(join(aliasDir, 'review.md'), 'utf8');
    // review → [mutation-adequacy, review] (map order). Match the backtick-quoted
    // skill tokens so `review` does not collide with the command title/description.
    expect(review).toContain('`mutation-adequacy`');
    expect(review).toContain('`review`');
    expect(review.indexOf('`mutation-adequacy`')).toBeLessThan(
      review.indexOf('`review`'),
    );
    expect(review).toContain('$ARGUMENTS');
  });

  it('multi-skill commands name every mapped skill in order (delegate)', () => {
    const aliasDir = emitOpencode();
    const delegate = readFileSync(join(aliasDir, 'delegate.md'), 'utf8');
    // delegate → [delegate, git-worktrees] (identity-collapsed skill name)
    expect(delegate).toContain('`delegate`');
    expect(delegate).toContain('`git-worktrees`');
    expect(delegate.indexOf('`delegate`')).toBeLessThan(
      delegate.indexOf('`git-worktrees`'),
    );
  });

  it('does NOT emit alias files for COMMAND_ONLY commands', () => {
    const aliasDir = emitOpencode();
    for (const cmd of ['autocompact', 'tag']) {
      expect(existsSync(join(aliasDir, `${cmd}.md`))).toBe(false);
    }
  });

  it('is deterministic: two runs produce byte-identical output', () => {
    const opencode = loadRuntime(join(REPO_RUNTIMES_DIR, 'opencode.yaml'));
    const a = makeTempDir();
    const b = makeTempDir();
    buildCommandAliases({ runtimes: [opencode], commandsDir: REPO_COMMANDS_DIR, outDir: a });
    buildCommandAliases({ runtimes: [opencode], commandsDir: REPO_COMMANDS_DIR, outDir: b });
    for (const key of COMMAND_KEYS) {
      const fa = readFileSync(join(a, 'opencode', `${key}.md`), 'utf8');
      const fb = readFileSync(join(b, 'opencode', `${key}.md`), 'utf8');
      expect(fa).toBe(fb);
    }
  });
});
