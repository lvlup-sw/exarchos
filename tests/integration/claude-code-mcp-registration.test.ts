/**
 * The onboard GENERATE step and the install path register the same Claude Code MCP entry.
 * The test runs `diff` and `apply` with the production writer list in a temp HOME and a temp project.
 * Then it compares the `~/.claude.json` entry with the entry of `registerExarchosInClaudeJson`.
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

/** Reads `mcpServers.exarchos` from `<home>/.claude.json`, with the state directory in POSIX form. */
async function exarchosEntry(home: string): Promise<unknown> {
  const config = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
  const entry = config.mcpServers.exarchos;
  return { ...entry, env: { ...entry.env, WORKFLOW_STATE_DIR: toPosix(entry.env.WORKFLOW_STATE_DIR) } };
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
});
