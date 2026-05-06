// Source: docs/designs/2026-05-05-e2e-v29-revisited.md §4.4 (T4.3)
//
// Process-fidelity smoke tests for `exarchos install-skills --agent claude` —
// the v2.9 install rewrite primary surface. The matrix row in the design says
// the post-condition contract is:
//
//   "After invocation, expected files exist under tmp/$HOME/.claude/;
//    ~/.claude.json contains MCP registration"
//
// This file asserts that contract. Where the current implementation does not
// satisfy it (e.g. no `.claude.json` writer; the upstream `npx skills add`
// CLI is interactive and selects nothing when stdin is closed), the test
// fails with a message that names exactly which sub-clause of the contract
// was violated. That is the design intent — the test is a tripwire for the
// known #1085-class regressions, not a mock that always passes.
//
// Hermeticity: every test wraps its work in `withHermeticEnv`, which sets
// `HOME` to a per-test tmp dir. The serialized mutex inside `withHermeticEnv`
// keeps `HOME` stable for the duration of each callback even if the file
// is run with concurrent vitest workers.
//
// Network dependency: the current install path shells out to
// `npx skills add github:lvlup-sw/exarchos`, which clones over HTTPS. These
// tests therefore require outbound network. There is no current way to run
// the install-skills CLI offline — that gap is itself a known concern and
// shows up as the slowest test runtime in the W3 suite.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { withHermeticEnv } from '../../fixtures/hermetic.js';
import { runCli } from '../../fixtures/cli-runner.js';

// Per-test timeout. The npx-driven git clone of the exarchos repo dominates
// the runtime (~20–30s on a warm npm cache, longer on a cold one). 90s gives
// headroom without making a stuck test wait the full default 30s × N attempts.
const INSTALL_TIMEOUT_MS = 90_000;

// The Claude runtime's `skillsInstallPath` from `runtimes/claude.yaml`.
// Hard-coded here (rather than parsed from YAML at test time) so the test
// fails with a clear assertion message when this contract drifts — drift in
// the install target is precisely the bug class T4.3 is designed to catch.
const EXPECTED_SKILLS_DIR_REL = path.join('.claude', 'skills');

// One representative skill that the rendered `skills/claude/` tree is known
// to ship. `delegation` has been present since v2.0 and is referenced by
// commands and rules; if the install puts no SKILL.md anywhere under
// `<home>/.claude/skills/`, the install side of the surface is broken
// regardless of which skill name we picked.
const REPRESENTATIVE_SKILL = 'delegation';

interface InstallProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Drive `exarchos install-skills --agent claude` inside the active hermetic
 * environment. Returns the structured CLI result so individual tests can
 * assert on exit code, output, or post-conditions without each one re-typing
 * the runCli boilerplate.
 *
 * `runCli` closes the child's stdin immediately when no `stdin` payload is
 * supplied (see fixtures/cli-runner.ts), which prevents the upstream
 * `@clack/prompts` interactive selector inside `npx skills add` from blocking
 * the test indefinitely. The trade-off is that no skills are interactively
 * selected — exactly the post-condition T4.3 is asserting.
 */
async function runInstallSkills(homeDir: string): Promise<InstallProbeResult> {
  const result = await runCli({
    args: ['install-skills', '--agent', 'claude'],
    env: { HOME: homeDir, NON_INTERACTIVE: '1' },
    timeout: INSTALL_TIMEOUT_MS,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}

/**
 * Walk `<homeDir>/.claude/skills/` and return the absolute path of the first
 * `SKILL.md` we find under any subdirectory. Returns `undefined` if either the
 * top-level directory is missing or no SKILL.md exists anywhere beneath it.
 *
 * The walk is intentionally shallow — we only recurse one level — because the
 * installed layout is `~/.claude/skills/<skill-name>/SKILL.md`, never deeper.
 * Keeping the walk shallow also avoids matching unrelated `SKILL.md` files
 * that other tools might place under home.
 */
async function findFirstSkillFile(
  homeDir: string,
): Promise<string | undefined> {
  const skillsRoot = path.join(homeDir, EXPECTED_SKILLS_DIR_REL);
  let entries: string[];
  try {
    entries = await fs.readdir(skillsRoot);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    const candidate = path.join(skillsRoot, name, 'SKILL.md');
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Not a SKILL-bearing dir — keep looking.
    }
  }
  return undefined;
}

describe('exarchos install-skills --agent claude (T4.3 smoke)', () => {
  it(
    'installSkills_agentClaude_writesExpectedFiles',
    async () => {
      await withHermeticEnv(async (env) => {
        const result = await runInstallSkills(env.homeDir);

        expect(
          result.exitCode,
          `install-skills should exit 0; stderr=${result.stderr.slice(0, 800)}`,
        ).toBe(0);

        // Primary post-condition: at least one SKILL.md file exists under
        // <home>/.claude/skills/<some-skill>/SKILL.md.
        const skillFile = await findFirstSkillFile(env.homeDir);
        expect(
          skillFile,
          [
            `Expected at least one SKILL.md under ${path.join(
              env.homeDir,
              EXPECTED_SKILLS_DIR_REL,
            )}/<skill>/SKILL.md after install-skills.`,
            `Probe target: <home>/.claude/skills/${REPRESENTATIVE_SKILL}/SKILL.md`,
            `install-skills stdout (head):\n${result.stdout.slice(0, 600)}`,
          ].join('\n'),
        ).toBeDefined();

        // Subordinate clauses — only meaningful once the file exists.
        const contents = await fs.readFile(skillFile as string, 'utf8');
        expect(
          contents.length,
          `${skillFile} exists but is empty.`,
        ).toBeGreaterThan(0);
        expect(
          contents,
          `${skillFile} is missing the expected YAML 'name:' frontmatter field.`,
        ).toMatch(/^---[\s\S]*?\bname:\s*\S+/m);
      });
    },
    INSTALL_TIMEOUT_MS + 10_000,
  );

  it(
    'installSkills_agentClaude_registersMcpServerInClaudeJson',
    async () => {
      await withHermeticEnv(async (env) => {
        const result = await runInstallSkills(env.homeDir);
        expect(
          result.exitCode,
          `install-skills should exit 0; stderr=${result.stderr.slice(0, 800)}`,
        ).toBe(0);

        const claudeJsonPath = path.join(env.homeDir, '.claude.json');
        let raw: string;
        try {
          raw = await fs.readFile(claudeJsonPath, 'utf8');
        } catch (err) {
          throw new Error(
            [
              `Expected ${claudeJsonPath} to exist after install-skills`,
              '(per docs/designs/2026-05-05-e2e-v29-revisited.md §4.4 matrix:',
              '"~/.claude.json contains MCP registration"), but readFile failed:',
              err instanceof Error ? err.message : String(err),
            ].join(' '),
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          throw new Error(
            `~/.claude.json exists but is not valid JSON: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // Shape probe — we only assert that there is an `exarchos` MCP
        // registration with a `command` string. The rest of the MCP entry's
        // shape (args, env) is intentionally left unconstrained at the smoke
        // tier; a future parity test will pin it down once the install side
        // settles.
        expect(parsed).toMatchObject({
          mcpServers: {
            exarchos: expect.objectContaining({
              command: expect.any(String),
            }),
          },
        });
      });
    },
    INSTALL_TIMEOUT_MS + 10_000,
  );

  it(
    'installSkills_idempotent_secondRunNoChanges',
    async () => {
      await withHermeticEnv(async (env) => {
        const first = await runInstallSkills(env.homeDir);
        expect(
          first.exitCode,
          `first install-skills should exit 0; stderr=${first.stderr.slice(0, 800)}`,
        ).toBe(0);

        const skillFile = await findFirstSkillFile(env.homeDir);
        if (!skillFile) {
          // If the install didn't write anything, idempotence is vacuously
          // true but uninteresting — the more useful signal is that the
          // primary post-condition is broken. Fail loudly here so the matrix
          // has a clear data point rather than a misleading green.
          throw new Error(
            [
              'Cannot evaluate idempotence: first install-skills run produced',
              `no SKILL.md under ${path.join(
                env.homeDir,
                EXPECTED_SKILLS_DIR_REL,
              )}.`,
              'Surface: install-skills primary write-path is broken. See test',
              '`installSkills_agentClaude_writesExpectedFiles` for the same gap.',
            ].join(' '),
          );
        }

        const beforeStat = await fs.stat(skillFile);
        const beforeBytes = await fs.readFile(skillFile);

        const second = await runInstallSkills(env.homeDir);
        expect(
          second.exitCode,
          `second install-skills should exit 0; stderr=${second.stderr.slice(0, 800)}`,
        ).toBe(0);

        const afterStat = await fs.stat(skillFile);
        const afterBytes = await fs.readFile(skillFile);

        // Accept either idempotence semantic: (a) mtime unchanged, OR
        // (b) byte-identical content. If neither holds, surface it as a
        // genuine non-idempotence finding so the orchestrator can decide
        // whether to file a bug.
        const mtimePreserved =
          afterStat.mtimeMs === beforeStat.mtimeMs;
        const bytesIdentical = beforeBytes.equals(afterBytes);

        expect(
          mtimePreserved || bytesIdentical,
          [
            'install-skills is non-idempotent on the second run.',
            `file=${skillFile}`,
            `before mtimeMs=${beforeStat.mtimeMs} size=${beforeStat.size}`,
            `after  mtimeMs=${afterStat.mtimeMs} size=${afterStat.size}`,
            `bytes identical? ${bytesIdentical}`,
          ].join(' | '),
        ).toBe(true);
      });
    },
    INSTALL_TIMEOUT_MS * 2 + 10_000,
  );
});
