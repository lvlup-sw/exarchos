/**
 * The reviewer agent is read-only and is still given the Exarchos MCP server.
 * `exarchos mcp` builds that server through `initializeContext` and `createMcpServer`.
 * `createServer` installs the same process capability resolver.
 * A reviewer session can read. It must not append events, merge a branch, or run a project command.
 * These tests fail while that server grants the local operator capability set.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpServer } from '../../src/adapters/mcp/mcp.js';
import {
  connectV2Client,
  connectV2Server,
  createV2Client,
  createV2LinkedTransportPair,
  type V2Client,
} from '../../src/contract/sdk/seam.js';
import { initializeContext } from '../../src/dispatch/core/context.js';
import { createServer } from '../../src/index.js';
import { resetInstallFreshnessGateForTest } from '../../src/install/freshness-gate.js';
import { __resetMachineryConsumedCache } from '../../src/dispatch/core/interceptors/session-machinery.js';
import { configureStateStoreBackend } from '../../src/workflow/state-store.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const AUTH_DENIAL = new Set([
  'CAPABILITY_DENIED',
  'ADMISSION_DENIED',
  'TRUSTED_CALLER_REQUIRED',
]);

interface ToolEnvelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string };
}

interface OpenedServer {
  readonly client: V2Client;
  readonly stateDir: string;
  close(): Promise<void>;
}

/**
 * Actions outside the read-only allowlist whose needs are none.
 * The read-only gate is the check that stops them. Admission does not.
 * Each row is a schema-valid call. The named stream is the object the call acts on.
 */
const GATE_ONLY_CALLS: readonly {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly stream: string;
}[] = [
  {
    tool: 'exarchos_event',
    stream: 'reviewer-append',
    args: {
      action: 'append',
      stream: 'reviewer-append',
      event: { type: 'task.progressed', data: { taskId: 't1', tddPhase: 'red' } },
    },
  },
  {
    tool: 'exarchos_event',
    stream: 'reviewer-batch',
    args: {
      action: 'batch_append',
      stream: 'reviewer-batch',
      events: [{ type: 'task.progressed', data: { taskId: 't1', tddPhase: 'green' } }],
    },
  },
  {
    tool: 'exarchos_workflow',
    stream: 'reviewer-init',
    args: { action: 'init', featureId: 'reviewer-init', workflowType: 'feature' },
  },
  {
    tool: 'exarchos_workflow',
    stream: 'reviewer-transition',
    args: { action: 'transition', featureId: 'reviewer-transition', target: 'plan' },
  },
  {
    tool: 'exarchos_workflow',
    stream: 'reviewer-update',
    args: { action: 'update', featureId: 'reviewer-update', updates: { note: 'from-reviewer' } },
  },
  {
    tool: 'exarchos_workflow',
    stream: 'reviewer-cancel',
    args: { action: 'cancel', featureId: 'reviewer-cancel', reason: 'reviewer' },
  },
  {
    tool: 'exarchos_workflow',
    stream: 'reviewer-cleanup',
    args: { action: 'cleanup', featureId: 'reviewer-cleanup', mergeVerified: true },
  },
  {
    tool: 'exarchos_workflow',
    stream: 'reviewer-reconcile',
    args: { action: 'reconcile', featureId: 'reviewer-reconcile' },
  },
  {
    tool: 'exarchos_workflow',
    stream: 'reviewer-rehydrate',
    args: { action: 'rehydrate', featureId: 'reviewer-rehydrate' },
  },
  {
    tool: 'exarchos_workflow',
    stream: 'reviewer-checkpoint',
    args: { action: 'checkpoint', featureId: 'reviewer-checkpoint', summary: 'reviewer' },
  },
  {
    tool: 'exarchos_workflow',
    stream: 'meta/feedback',
    args: { action: 'feedback', message: 'reviewer forced a feedback write' },
  },
];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

async function initRepo(root: string): Promise<{ readonly integration: string }> {
  mkdirSync(root, { recursive: true });
  await git(root, ['init', '-b', 'integration']);
  await git(root, ['config', 'user.email', 'reviewer-test@example.com']);
  await git(root, ['config', 'user.name', 'Reviewer Test']);
  writeFileSync(path.join(root, 'base.txt'), 'base\n');
  await git(root, ['add', 'base.txt']);
  await git(root, ['commit', '-m', 'base']);
  const integration = await git(root, ['rev-parse', 'integration']);
  await git(root, ['checkout', '-b', 'feature']);
  writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
  await git(root, ['add', 'feature.txt']);
  await git(root, ['commit', '-m', 'feature']);
  await git(root, ['checkout', '-b', 'holding', 'integration']);
  return { integration };
}

function writeProject(root: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'reviewer-probe',
      private: true,
      scripts: { lint: 'node marker.mjs' },
    }),
  );
  writeFileSync(
    path.join(root, 'marker.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./reviewer-ran.txt', import.meta.url), 'ran\\n');\n",
  );
  return path.join(root, 'reviewer-ran.txt');
}

async function callTool(
  client: V2Client,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  const result = (await client.callTool({ name: tool, arguments: args })) as {
    structuredContent?: ToolEnvelope;
    isError?: boolean;
  };
  const env = result.structuredContent;
  if (env === undefined || typeof env.success !== 'boolean') {
    throw new Error(`MCP call ${tool} returned no envelope`);
  }
  return env;
}

async function streamEvents(client: V2Client, stream: string): Promise<readonly unknown[]> {
  const env = await callTool(client, 'exarchos_event', { action: 'query', stream });
  if (!env.success) {
    throw new Error(`query ${stream} failed: ${env.error?.code ?? ''} ${env.error?.message ?? ''}`);
  }
  const data = env.data;
  if (typeof data !== 'object' || data === null || !('events' in data)) return [];
  const events = (data as { events?: unknown }).events;
  return Array.isArray(events) ? events : [];
}

function expectNoSideEffect(events: readonly unknown[], extraPaths: readonly string[]): void {
  expect(events).toEqual([]);
  for (const filePath of extraPaths) {
    expect(existsSync(filePath)).toBe(false);
  }
}

function refusalCode(env: ToolEnvelope): string {
  return env.success ? 'SUCCESS' : (env.error?.code ?? 'NO_CODE');
}

async function openCliMcp(stateDir: string): Promise<OpenedServer> {
  process.env.EXARCHOS_TELEMETRY = 'false';
  const ctx = await initializeContext(stateDir);
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = createV2LinkedTransportPair();
  const client = createV2Client(
    { name: 'exarchos-reviewer', version: '0.0.0' },
    { capabilities: {} },
  );
  await Promise.all([
    connectV2Server(server, serverTransport),
    connectV2Client(client, clientTransport),
  ]);
  return {
    client,
    stateDir,
    async close() {
      await client.close();
      ctx.eventStore.close();
    },
  };
}

async function openCreateServer(stateDir: string): Promise<OpenedServer> {
  process.env.EXARCHOS_TELEMETRY = 'false';
  const server = await createServer(stateDir);
  const [clientTransport, serverTransport] = createV2LinkedTransportPair();
  const client = createV2Client(
    { name: 'exarchos-reviewer', version: '0.0.0' },
    { capabilities: {} },
  );
  await Promise.all([
    connectV2Server(server, serverTransport),
    connectV2Client(client, clientTransport),
  ]);
  return {
    client,
    stateDir,
    async close() {
      await client.close();
    },
  };
}

describe('reviewer MCP session cannot use the operator grant', () => {
  const dirs: string[] = [];
  let workspaceHead = '';

  afterEach(async () => {
    resetInstallFreshnessGateForTest();
    __resetMachineryConsumedCache();
    configureStateStoreBackend(undefined);
    for (const dir of dirs.splice(0)) {
      rmrf(dir);
    }
    if (workspaceHead !== '') {
      const head = await git(process.cwd(), ['rev-parse', 'HEAD']);
      if (head !== workspaceHead) {
        await git(process.cwd(), ['reset', '--keep', workspaceHead]);
      }
    }
  });

  /**
   * A read of an empty stream stays available to the reviewer.
   * The refusal tests below use this same session shape.
   */
  it('reviewer_session_can_query_an_empty_stream', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'reviewer-mcp-'));
    dirs.push(stateDir);
    const opened = await openCliMcp(stateDir);
    try {
      const events = await streamEvents(opened.client, 'reviewer-empty');
      expect(events).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  /**
   * Needs-none mutations are stopped only by the read-only gate.
   * The gate must refuse the named stream, and that stream must stay empty.
   * A refusal that runs the handler, or that writes a different stream, fails.
   */
  it.each(GATE_ONLY_CALLS)(
    'cli_mcp_refuses_$args.action',
    async (call) => {
      const stateDir = mkdtempSync(path.join(tmpdir(), 'reviewer-mcp-'));
      dirs.push(stateDir);
      const opened = await openCliMcp(stateDir);
      try {
        const env = await callTool(opened.client, call.tool, call.args);
        const events = await streamEvents(opened.client, call.stream);
        const stateFile = path.join(stateDir, `${call.stream}.state.json`);
        expectNoSideEffect(events, [stateFile]);
        expect(refusalCode(env), env.error?.message ?? JSON.stringify(env.data)).toBe(
          'CAPABILITY_DENIED',
        );
      } finally {
        await opened.close();
      }
    },
  );

  /**
   * `createServer` is the other entry that installs the process resolver.
   * An append through it must refuse the same way, and the stream must stay empty.
   */
  it('createServer_refuses_event_append', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'reviewer-mcp-'));
    dirs.push(stateDir);
    const opened = await openCreateServer(stateDir);
    try {
      const env = await callTool(opened.client, 'exarchos_event', {
        action: 'append',
        stream: 'reviewer-create-server',
        event: { type: 'task.progressed', data: { taskId: 't1', tddPhase: 'red' } },
      });
      const events = await streamEvents(opened.client, 'reviewer-create-server');
      expect(events).toEqual([]);
      expect(refusalCode(env), env.error?.message ?? '').toBe('CAPABILITY_DENIED');
    } finally {
      await opened.close();
    }
  });

  /**
   * The session first inits the workflow the merge stores, then merges feature into integration.
   * Both calls must be refused. The named repo, a second repo, and this checkout must keep their commits.
   * The feature stream and the state file must stay absent.
   */
  it('cli_mcp_refuses_merge_orchestrate', async () => {
    workspaceHead = await git(process.cwd(), ['rev-parse', 'HEAD']);
    const stateDir = mkdtempSync(path.join(tmpdir(), 'reviewer-mcp-'));
    const victim = mkdtempSync(path.join(tmpdir(), 'reviewer-repo-'));
    const bystander = mkdtempSync(path.join(tmpdir(), 'reviewer-other-repo-'));
    dirs.push(stateDir, victim, bystander);
    const victimBefore = await initRepo(victim);
    const bystanderBefore = await initRepo(bystander);
    const opened = await openCliMcp(stateDir);
    try {
      const initEnv = await callTool(opened.client, 'exarchos_workflow', {
        action: 'init',
        featureId: 'reviewer-merge',
        workflowType: 'feature',
      });
      const env = await callTool(opened.client, 'exarchos_orchestrate', {
        action: 'merge_orchestrate',
        featureId: 'reviewer-merge',
        sourceBranch: 'feature',
        targetBranch: 'integration',
        strategy: 'merge',
        repoRoot: victim,
      });
      const events = await streamEvents(opened.client, 'reviewer-merge');
      const stateFile = path.join(stateDir, 'reviewer-merge.state.json');
      expect(await git(victim, ['rev-parse', 'integration'])).toBe(victimBefore.integration);
      expectNoSideEffect(events, [stateFile]);
      expect(refusalCode(initEnv)).toBe('CAPABILITY_DENIED');
      expect(AUTH_DENIAL.has(refusalCode(env)), `${refusalCode(env)} ${env.error?.message ?? ''}`).toBe(
        true,
      );
      expect(await git(bystander, ['rev-parse', 'integration'])).toBe(bystanderBefore.integration);
      expect(await git(process.cwd(), ['rev-parse', 'HEAD'])).toBe(workspaceHead);
    } finally {
      await opened.close();
    }
  });

  /**
   * Static analysis runs the project lint script. The script writes a marker file.
   * The call names one project. A second project must not run.
   * The feature stream must gain no gate evidence and no other event.
   */
  it('cli_mcp_refuses_project_lint_command', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'reviewer-mcp-'));
    const project = mkdtempSync(path.join(tmpdir(), 'reviewer-project-'));
    const other = mkdtempSync(path.join(tmpdir(), 'reviewer-other-project-'));
    dirs.push(stateDir, project, other);
    const marker = writeProject(project);
    const otherMarker = writeProject(other);
    const opened = await openCliMcp(stateDir);
    try {
      const env = await callTool(opened.client, 'exarchos_orchestrate', {
        action: 'check_static_analysis',
        featureId: 'reviewer-lint',
        repoRoot: project,
        skipTypecheck: true,
      });
      const events = await streamEvents(opened.client, 'reviewer-lint');
      expectNoSideEffect(events, [marker, otherMarker]);
      expect(AUTH_DENIAL.has(refusalCode(env)), `${refusalCode(env)} ${env.error?.message ?? ''}`).toBe(
        true,
      );
      expect(existsSync(path.join(process.cwd(), 'reviewer-ran.txt'))).toBe(false);
    } finally {
      await opened.close();
    }
  });
});

/**
 * Operations that use the same operator grant and are not called above.
 * The other rows need a prepared workflow, a worktree lease, or a long host command.
 */
export const UNTESTED_SHARED_OPERATIONS: readonly string[] = [
  'exarchos_orchestrate.setup_worktree',
  'exarchos_orchestrate.serialize_merge',
  'exarchos_orchestrate.execute_intent',
  'exarchos_orchestrate.settle',
  'exarchos_orchestrate.prepare_delegation',
  'exarchos_orchestrate.onboard',
  'exarchos_orchestrate.doctor',
  'exarchos_orchestrate.check_integration_suite',
  'exarchos_orchestrate.post_delegation_check',
  'exarchos_orchestrate.verify_worktree_baseline',
  'exarchos_orchestrate.pre_synthesis_check',
  'exarchos_sync.now',
];

describe('untested shared operations stay named', () => {
  it('untested_list_is_non_empty', () => {
    expect(UNTESTED_SHARED_OPERATIONS.length).toBeGreaterThan(0);
  });
});
