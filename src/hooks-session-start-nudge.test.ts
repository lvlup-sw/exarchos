import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  statSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Tests for `hooks/session-start.sh` — the POSIX-sh preamble that guards
 * the SessionStart hook against a missing `exarchos` binary.
 *
 * The script must:
 *   1. Exit 0 with an install hint on stderr when `exarchos` is not on PATH
 *      (non-blocking — Claude Code must not show an error prompt).
 *   2. exec `exarchos session-start --plugin-root "${CLAUDE_PLUGIN_ROOT}"` when present.
 *   3. Be wired into `hooks/hooks.json` (replaces the bare `exarchos session-start`).
 */

const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT_PATH = join(REPO_ROOT, 'hooks', 'session-start.sh');
const HOOKS_JSON = join(REPO_ROOT, 'hooks', 'hooks.json');

// A hermetic PATH that contains only the stub directory we point at, so the
// real `exarchos` binary (if installed in CI) can never leak in.
//
// We deliberately do NOT include /usr/bin, /bin etc. on the "missing" path —
// `command -v` is a POSIX shell builtin and does not require external tools.
function hermeticEnv(stubDir: string | null): NodeJS.ProcessEnv {
  return {
    // Claude Code passes CLAUDE_PLUGIN_ROOT through; we mimic that.
    CLAUDE_PLUGIN_ROOT: REPO_ROOT,
    // Use only the stub dir (or an empty path) so `exarchos` lookups are deterministic.
    PATH: stubDir ?? '/nonexistent-hermetic-path',
    // Preserve HOME so `/bin/sh` can find its init files if needed, but not required.
    HOME: process.env.HOME ?? '/tmp',
  };
}

// Spawn the script under /bin/sh to prove POSIX-sh compliance (no bash-isms).
function runScript(env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync('/bin/sh', [SCRIPT_PATH], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env,
    timeout: 10_000,
  });
}

describe('hooks/session-start.sh — existence & shape', () => {
  it('SessionStartNudge_Script_ExistsAndIsExecutable', () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
    const st = statSync(SCRIPT_PATH);
    // Executable bit set for owner (0o100 == S_IXUSR) — required so
    // Claude Code can invoke it directly via the hook command string.
    expect((st.mode & 0o100) !== 0).toBe(true);
  });

  it('SessionStartNudge_Script_IsUnder30Lines', () => {
    const contents = readFileSync(SCRIPT_PATH, 'utf-8');
    const lineCount = contents.split('\n').length;
    expect(lineCount).toBeLessThan(30);
  });

  it('SessionStartNudge_Script_UsesPOSIXShebang', () => {
    const contents = readFileSync(SCRIPT_PATH, 'utf-8');
    // Must be `/bin/sh`, not `/bin/bash` — POSIX-sh only per task spec.
    expect(contents.startsWith('#!/bin/sh')).toBe(true);
  });
});

describe('hooks/session-start.sh — behavior', () => {
  let tmpRoot: string;
  let stubDir: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exarchos-nudge-test-'));
    stubDir = join(tmpRoot, 'stub-bin');
    // Create the stub directory up front; individual tests populate it.
    mkdirSync(stubDir, { recursive: true });
  });

  afterAll(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('SessionStartNudge_BinaryMissing_EmitsInstallHint', () => {
    // Empty stubDir: no `exarchos` anywhere on PATH.
    // Clear stubDir in case a prior test populated it.
    for (const f of readdirSync(stubDir)) {
      rmSync(join(stubDir, f), { force: true });
    }

    const result = runScript(hermeticEnv(stubDir));

    expect(result.status).toBe(0);
    // Install hint must reference the canonical bootstrap URL.
    expect(result.stderr).toContain('raw.githubusercontent.com/lvlup-sw/exarchos/main/scripts/get-exarchos.sh');
    // Hint goes to stderr only, not stdout (so it doesn't contaminate any
    // downstream hook consumer that reads stdout).
    expect(result.stdout).toBe('');
  });

  it('SessionStartNudge_BinaryMissing_ExitsZero', () => {
    // Same hermetic setup — binary absent.
    for (const f of readdirSync(stubDir)) {
      rmSync(join(stubDir, f), { force: true });
    }

    const result = runScript(hermeticEnv(stubDir));

    // CRITICAL: exit 0 so Claude Code does not error-prompt the user.
    // A non-zero exit would block session start.
    expect(result.status).toBe(0);
  });

  it('SessionStartNudge_BinaryPresent_DelegatesToExarchos', () => {
    // Install a stub `exarchos` that echoes its args to stdout.
    // The script should `exec` it, so the child's stdout becomes the script's stdout.
    for (const f of readdirSync(stubDir)) {
      rmSync(join(stubDir, f), { force: true });
    }
    const stubPath = join(stubDir, 'exarchos');
    writeFileSync(
      stubPath,
      `#!/bin/sh\nprintf '%s' "$*"\n`,
      { encoding: 'utf-8' },
    );
    chmodSync(stubPath, 0o755);

    const env = hermeticEnv(stubDir);
    // CLAUDE_PLUGIN_ROOT is set via hermeticEnv — assert it flows through.
    env.CLAUDE_PLUGIN_ROOT = '/tmp/fake-plugin-root';

    const result = runScript(env);

    expect(result.status).toBe(0);
    // The stub echoes its args — we should see the session-start command
    // with --plugin-root flowing through.
    expect(result.stdout).toContain('session-start');
    expect(result.stdout).toContain('--plugin-root');
    expect(result.stdout).toContain('/tmp/fake-plugin-root');
  });

  it('SessionStartNudge_InstallUrl_EnvOverride_FlowsIntoHint', () => {
    // REFACTOR: EXARCHOS_INSTALL_URL overrides the default bootstrap URL
    // so CI and forks can test against alternate sources.
    for (const f of readdirSync(stubDir)) {
      rmSync(join(stubDir, f), { force: true });
    }

    const env = hermeticEnv(stubDir);
    const overrideUrl = 'https://fork.example.com/bootstrap.sh';
    env.EXARCHOS_INSTALL_URL = overrideUrl;

    const result = runScript(env);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(overrideUrl);
    // The default URL must NOT appear when the override is set.
    expect(result.stderr).not.toContain('raw.githubusercontent.com/lvlup-sw/exarchos/main');
  });

  it('SessionStartNudge_BinaryPresent_UsesExecNotFork', () => {
    // Spawn a stub that records its own PID, then compare against the
    // script's PID. If the script used `exec`, the child replaces the
    // shell process, so there's no easy way to observe that from Node.
    //
    // Instead, we assert a weaker but meaningful property: the script
    // contains the literal `exec exarchos` token in its source. This is
    // a structural guarantee per the task spec's "adversarial posture":
    //   > Use a real `exec` in the happy path (not a plain invocation)
    //   > so the hook process is replaced; this matters for Claude Code
    //   > hook semantics.
    const contents = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(/\bexec\s+exarchos\b/.test(contents)).toBe(true);
  });
});

describe('hooks/hooks.json — SessionStart rewired to nudge script', () => {
  it('HooksJson_SessionStart_InvokesNudgeScript', () => {
    const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const cmd = config.hooks.SessionStart[0].hooks[0].command;
    // SessionStart command must point at the shell script via the plugin-root
    // placeholder, not run `exarchos` directly.
    expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh');
    // Must not invoke `exarchos` directly at the top-level command string.
    expect(cmd.startsWith('exarchos ')).toBe(false);
  });

  it('HooksJson_SessionStart_PreservesMatcherAndTimeout', () => {
    const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf-8')) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ timeout?: number; statusMessage?: string }> }>
      >;
    };
    const entry = config.hooks.SessionStart[0];
    // The rewire must not disturb matcher, timeout, or status message —
    // those are still required for SessionStart semantics.
    expect(entry.matcher).toBe('startup|resume');
    expect(entry.hooks[0].timeout).toBe(10);
    expect(entry.hooks[0].statusMessage).toBe('Checking for active workflows...');
  });
});
