/**
 * The onboard GENERATE step and the install path register the same Claude Code MCP entry.
 * The test runs `diff` and `apply` with the production writer list in a temp HOME and a temp project.
 * Then it compares the `~/.claude.json` entry with the entry of `registerExarchosInClaudeJson`.
 * A stale bundle entry from an older installer also gets a generate step, and `apply` replaces it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { apply, diff } from '../../src/dispatch/core/onboarding/reconcile.js';
import { getAllWriters } from '../../src/verbs/init/index.js';
import { buildWriterDeps } from '../../src/verbs/init/probes.js';
import { registerExarchosInClaudeJson } from '../../src/install/install-skills.js';
import { agentMcpRegistered } from '../../src/verbs/doctor/checks/agent-mcp-registered.js';
import { makeStubProbes } from '../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import { detectAgentEnvironments } from '../../src/runtime/agent-environment-detector.js';
import { toPosix } from '../../src/utils/paths.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/** The value of `key` in `value`, or `undefined` when `value` is not an object with that key. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(value);
  return entries.find(([k]) => k === key)?.[1];
}

/** Reads `mcpServers.exarchos` from `<home>/.claude.json`, with the state directory in POSIX form. The read fails when the entry has no state directory. */
async function exarchosEntry(home: string): Promise<unknown> {
  const config: unknown = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
  const entry = field(field(config, 'mcpServers'), 'exarchos');
  const env = field(entry, 'env');
  const stateDir = field(env, 'WORKFLOW_STATE_DIR');
  if (typeof entry !== 'object' || entry === null || typeof env !== 'object' || env === null || typeof stateDir !== 'string') {
    throw new Error(`no exarchos entry with a WORKFLOW_STATE_DIR in ${home}/.claude.json`);
  }
  return { ...entry, env: { ...env, WORKFLOW_STATE_DIR: toPosix(stateDir) } };
}

describe('Claude Code MCP registration parity', () => {
  let base: string;
  let home: string;
  let project: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'claude-mcp-entry-'));
    home = path.join(base, 'home');
    project = path.join(base, 'project');
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await rmrfAsync(base);
  });

  /**
   * A Claude Code user with no `exarchos` entry gets a generate step from the doctor check.
   * The entry that the step writes must equal the entry of the install path.
   * `registerExarchosInClaudeJson` rewrites an entry that differs, so the second read is always its own entry.
   */
  it('OnboardGenerate_ClaudeCodeEntry_EqualsTheInstallRegistration', async () => {
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 3 }), 'utf8');
    const probes = makeStubProbes({
      detector: (signal) => detectAgentEnvironments({ home: () => home, cwd: () => project }, signal),
    });
    const check = await agentMcpRegistered(probes, new AbortController().signal);
    expect(check.status).toBe('Warning');

    const plan = diff({ runtimes: [], vcs: 'none', commands: {} }, [check]);
    expect(plan.steps.map((s) => `${s.kind}:${s.key}`)).toEqual(['generate:agent-mcp-registered']);

    await apply(plan, {
      repoRoot: project,
      surface: 'cli',
      writerDeps: { ...buildWriterDeps(), home: () => home, cwd: () => project },
      writers: getAllWriters(),
    });
    const generated = await exarchosEntry(home);

    registerExarchosInClaudeJson(home);
    const installed = await exarchosEntry(home);

    expect(generated).toEqual(installed);
    expect(JSON.stringify(generated)).not.toContain('mcp-servers');
  });

  /**
   * An older installer wrote `node ~/.claude/mcp-servers/exarchos-mcp.js`, and nothing installs that file.
   * The doctor check must warn on this entry, so `diff` plans the generate step and `apply` replaces the entry.
   * After `apply` the check passes, so a second onboard plans nothing.
   */
  it('OnboardGenerate_StaleBundleEntry_IsReplacedByTheInstallRegistration', async () => {
    const staleEntry = {
      type: 'stdio',
      command: 'node',
      args: [toPosix(path.join(home, '.claude', 'mcp-servers', 'exarchos-mcp.js'))],
      env: { WORKFLOW_STATE_DIR: toPosix(path.join(home, '.claude', 'workflow-state')) },
    };
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { exarchos: staleEntry } }), 'utf8');
    const probes = makeStubProbes({
      detector: (signal) => detectAgentEnvironments({ home: () => home, cwd: () => project }, signal),
    });
    const check = await agentMcpRegistered(probes, new AbortController().signal);
    expect(check.status).toBe('Warning');

    const plan = diff({ runtimes: [], vcs: 'none', commands: {} }, [check]);
    expect(plan.steps.map((s) => `${s.kind}:${s.key}`)).toEqual(['generate:agent-mcp-registered']);

    await apply(plan, {
      repoRoot: project,
      surface: 'cli',
      writerDeps: { ...buildWriterDeps(), home: () => home, cwd: () => project },
      writers: getAllWriters(),
    });
    const generated = await exarchosEntry(home);
    expect(field(generated, 'command')).toBe('exarchos');
    expect(field(generated, 'args')).toEqual(['mcp']);

    const recheck = await agentMcpRegistered(probes, new AbortController().signal);
    expect(recheck.status).toBe('Pass');

    registerExarchosInClaudeJson(home);
    expect(generated).toEqual(await exarchosEntry(home));
  });
});
