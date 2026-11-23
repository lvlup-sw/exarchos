/**
 * The read-only reviewer is given the Exarchos MCP server, and that server's
 * dispatch context is the local operator capability set. These tests are the
 * contract for closing that gap. They fail while a reviewer session can merge,
 * comment, or append, and they pass once that session is denied before any
 * handler side effect.
 *
 * The same gate covers every action outside the read-only allowlist. This file
 * runs the operations named by the report (merge, comment, event append) and
 * the sibling mutations that share that gate and the VCS or event handler
 * (create pull request, create issue, batch append, and the prepare admission
 * needs). It does not invoke the other mutating workflow, orchestrate, or sync
 * actions one by one. Those actions use the same resolver and the same gate.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCliDispatchContext } from '../../../../src/adapters/cli/cli.js';
import {
  connectV2Client,
  connectV2Server,
  createV2Client,
  createV2LinkedTransportPair,
  type V2Client,
} from '../../../../src/contract/sdk/seam.js';
import { createMcpDispatchContext } from '../../../../src/adapters/mcp/mcp.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
  type McpCallerRuntimeContext,
} from '../../../../src/dispatch/caller-identity.js';
import { initializeContext } from '../../../../src/dispatch/core/context.js';
import { evaluateDispatchAdmission } from '../../../../src/dispatch/core/dispatch-admission.js';
import {
  dispatch,
  type DispatchContext,
} from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { createServer } from '../../../../src/index.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { REVIEWER } from '../../../../src/runtime/agents/definitions.js';
import { codexAdapter } from '../../../../src/runtime/agents/adapters/codex.js';
import { generateClaudeAgentMarkdown } from '../../../../src/runtime/agents/adapters/claude.js';
import { EventStore } from '../../../../src/events/store.js';
import {
  createInMemoryResolver,
  type CapabilityResolver,
} from '../../../../src/workflow/capabilities/resolver.js';
import { capabilitiesForPosture, resolveCapabilities } from '../../../../src/workflow/capabilities/posture-mapping.js';

const execFileAsync = promisify(execFile);

const REVIEWER_SESSION: McpCallerRuntimeContext = { sessionId: 'reviewer-mcp-session' };

function expectCapabilityDenied(result: ToolResult): void {
  expect(result.success).toBe(false);
  expect(result.error?.code).toBe('CAPABILITY_DENIED');
}

async function storedEventCount(eventStore: EventStore): Promise<number> {
  let count = 0;
  for (const streamId of eventStore.listStreams()) {
    count += (await eventStore.query(streamId)).length;
  }
  return count;
}

function ghInvocationLines(logPath: string): string[] {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

describe('reviewer agent is wired to the shared Exarchos server', () => {
  it('resolves the reviewer to filesystem read and the read-only Exarchos capability, and both adapters publish that server', () => {
    const capabilities = [...resolveCapabilities(REVIEWER.posture, REVIEWER.id)].sort();
    expect(capabilities).toEqual(['fs:read', 'mcp:exarchos:readonly']);

    const claude = generateClaudeAgentMarkdown(REVIEWER);
    expect(claude).toContain('mcpServers:');
    expect(claude).toContain('- exarchos');

    const codex = codexAdapter.lowerSpec(REVIEWER);
    expect(codex.contents).toContain('sandbox_mode = "read-only"');
    expect(codex.contents).toContain('mcp_servers = ["exarchos"]');
  });
});

describe('MCP session capability boundary', () => {
  let root: string;
  let ghLogPath: string;
  let savedPath: string | undefined;
  let base: DispatchContext;
  let reviewer: DispatchContext;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-reviewer-capability-'));
    ghLogPath = join(root, 'gh-invocations.log');
    writeFileSync(ghLogPath, '');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const stub = join(bin, 'gh');
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_INVOCATION_LOG"\nexit 1\n',
    );
    await execFileAsync('chmod', ['755', stub]);

    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.GH_INVOCATION_LOG = ghLogPath;

    base = await initializeContext(join(root, 'state'));
    reviewer = createMcpDispatchContext(
      { ...base, enableTelemetry: false },
      REVIEWER_SESSION,
    );
  });

  afterAll(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    delete process.env.GH_INVOCATION_LOG;
    base?.eventStore.close();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeFileSync(ghLogPath, '');
  });

  async function expectNoHandlerSideEffect(before: number): Promise<void> {
    expect(ghInvocationLines(ghLogPath)).toEqual([]);
    expect(await storedEventCount(base.eventStore)).toBe(before);
  }

  it('keeps the operator capability grant on the CLI identity', () => {
    const cli = createCliDispatchContext(base);
    const authorization = snapshotCallerAuthorization(cli.callerIdentity, cli.capabilityResolver);
    expect(authorization.identity.kind).toBe('local-operator');
    expect(authorization.posture).toBe('shared-mutating');
    expect(authorization.capabilities).toContain('mcp:exarchos');
  });

  it('gives the MCP session only the read-only reviewer capability set', () => {
    const authorization = snapshotCallerAuthorization(
      reviewer.callerIdentity,
      reviewer.capabilityResolver,
    );
    expect(authorization.identity.kind).toBe('mcp-session');
    expect(authorization.posture).toBe('read-only');
    expect([...authorization.capabilities]).toEqual(['fs:read', 'mcp:exarchos:readonly']);
  });

  it('denies prepare, which needs write and shell, before the handler', async () => {
    const action = findActionInRegistry('exarchos_orchestrate', 'prepare');
    expect(action).toBeDefined();
    const before = await storedEventCount(base.eventStore);
    const admission = await evaluateDispatchAdmission({
      tool: 'exarchos_orchestrate',
      actionName: 'prepare',
      action: action as object,
      args: { featureId: 'reviewer-feature', repoRoot: '/tmp/reviewer-repo' },
      ctx: reviewer,
      authorization: snapshotCallerAuthorization(reviewer.callerIdentity, reviewer.capabilityResolver),
    });
    expect(admission).not.toBeNull();
    expect(admission?.success).toBe(false);
    expect(admission?.error?.code).toBe('ADMISSION_DENIED');
    await expectNoHandlerSideEffect(before);
  });

  it('still allows an event query', async () => {
    const before = await storedEventCount(base.eventStore);
    const result = await dispatch(
      'exarchos_event',
      { action: 'query', stream: 'reviewer-feature' },
      reviewer,
    );
    expect(result.success).toBe(true);
    await expectNoHandlerSideEffect(before);
  });

  it('denies merge_pr before the pull request provider runs', async () => {
    const before = await storedEventCount(base.eventStore);
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'merge_pr', prId: '1', strategy: 'squash' },
      reviewer,
    );
    expectCapabilityDenied(result);
    await expectNoHandlerSideEffect(before);
  });

  it('denies add_pr_comment before a comment is posted', async () => {
    const before = await storedEventCount(base.eventStore);
    const comment = await dispatch(
      'exarchos_orchestrate',
      { action: 'add_pr_comment', prId: '1', body: 'injected comment' },
      reviewer,
    );
    expectCapabilityDenied(comment);
    await expectNoHandlerSideEffect(before);
  });

  it('denies add_pr_comment thread replies before a reply is posted', async () => {
    const before = await storedEventCount(base.eventStore);
    const reply = await dispatch(
      'exarchos_orchestrate',
      { action: 'add_pr_comment', prId: '1', threadId: '9', body: 'injected reply' },
      reviewer,
    );
    expectCapabilityDenied(reply);
    await expectNoHandlerSideEffect(before);
  });

  it('denies create_pr before a pull request is opened or journaled', async () => {
    const before = await storedEventCount(base.eventStore);
    const pull = await dispatch(
      'exarchos_orchestrate',
      {
        action: 'create_pr',
        title: 'injected',
        body: 'injected body',
        base: 'main',
        head: 'injected-head',
      },
      reviewer,
    );
    expectCapabilityDenied(pull);
    await expectNoHandlerSideEffect(before);
  });

  it('denies create_issue before an issue is opened or journaled', async () => {
    const before = await storedEventCount(base.eventStore);
    const issue = await dispatch(
      'exarchos_orchestrate',
      { action: 'create_issue', title: 'injected', body: 'injected body' },
      reviewer,
    );
    expectCapabilityDenied(issue);
    await expectNoHandlerSideEffect(before);
  });

  it('denies event append before the event store changes', async () => {
    const before = await storedEventCount(base.eventStore);
    const append = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: 'reviewer-feature',
        event: { type: 'task.progressed', data: { taskId: 't1', tddPhase: 'red' } },
      },
      reviewer,
    );
    expectCapabilityDenied(append);
    await expectNoHandlerSideEffect(before);
  });

  it('denies batch_append before the event store changes', async () => {
    const before = await storedEventCount(base.eventStore);
    const batch = await dispatch(
      'exarchos_event',
      {
        action: 'batch_append',
        stream: 'reviewer-feature',
        events: [{ type: 'task.progressed', data: { taskId: 't1', tddPhase: 'green' } }],
      },
      reviewer,
    );
    expectCapabilityDenied(batch);
    await expectNoHandlerSideEffect(before);
  });

  it('denies merge and append for a resolver that only holds the read-only capability, even when a later lookup would grant the full capability', async () => {
    const readOnly = createInMemoryResolver(capabilitiesForPosture('read-only'));
    let gateReads = 0;
    const resolverForOneCall = (): CapabilityResolver => {
      let reads = 0;
      return {
        has(capability) {
          const readIndex = reads;
          reads += 1;
          gateReads += 1;
          if (readIndex < 2) return readOnly.has(capability);
          return capability === 'mcp:exarchos' || readOnly.has(capability);
        },
        list() {
          return ['mcp:exarchos', 'fs:read', 'fs:write', 'shell:exec', 'subagent:spawn'];
        },
        snapshot: readOnly.snapshot.bind(readOnly),
        isRootsDeclared: readOnly.isRootsDeclared.bind(readOnly),
        isElicitationDeclared: readOnly.isElicitationDeclared.bind(readOnly),
        isTaskSupportDeclared: readOnly.isTaskSupportDeclared.bind(readOnly),
        getCachedRoots: readOnly.getCachedRoots.bind(readOnly),
        setCachedRoots: readOnly.setCachedRoots.bind(readOnly),
        invalidateRootsCache: readOnly.invalidateRootsCache.bind(readOnly),
      };
    };
    const call = (resolver: CapabilityResolver) => ({
      ...reviewer,
      capabilityResolver: resolver,
      callerIdentity: deriveMcpCallerIdentity(REVIEWER_SESSION),
    });
    const before = await storedEventCount(base.eventStore);
    const merge = await dispatch(
      'exarchos_orchestrate',
      { action: 'merge_pr', prId: '1', strategy: 'merge' },
      call(resolverForOneCall()),
    );
    expectCapabilityDenied(merge);
    const append = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: 'reviewer-feature',
        event: { type: 'task.progressed', data: { taskId: 't2', tddPhase: 'refactor' } },
      },
      call(resolverForOneCall()),
    );
    expectCapabilityDenied(append);
    expect(gateReads).toBeGreaterThan(0);
    await expectNoHandlerSideEffect(before);
  });
});

describe('createServer MCP client', () => {
  let root: string;
  let ghLogPath: string;
  let savedPath: string | undefined;
  let client: V2Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-reviewer-server-'));
    ghLogPath = join(root, 'gh-invocations.log');
    writeFileSync(ghLogPath, '');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const stub = join(bin, 'gh');
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_INVOCATION_LOG"\nexit 1\n',
    );
    await execFileAsync('chmod', ['755', stub]);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.GH_INVOCATION_LOG = ghLogPath;

    const server = await createServer(join(root, 'state'));
    const [clientTransport, serverTransport] = createV2LinkedTransportPair();
    client = createV2Client({ name: 'reviewer-client', version: '0' }, { capabilities: {} });
    await Promise.all([
      connectV2Server(server, serverTransport),
      connectV2Client(client, clientTransport),
    ]);
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    delete process.env.GH_INVOCATION_LOG;
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  function envelopeOf(result: { structuredContent?: unknown; content?: unknown }): { success?: boolean; error?: { code?: string } } {
    const structured = result.structuredContent;
    if (typeof structured === 'object' && structured !== null) {
      return structured as { success?: boolean; error?: { code?: string } };
    }
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0) return {};
    const text = content[0];
    if (typeof text !== 'object' || text === null || !('text' in text) || typeof text.text !== 'string') {
      return {};
    }
    return JSON.parse(text.text) as { success?: boolean; error?: { code?: string } };
  }

  async function expectServerDenied(tool: string, args: Record<string, unknown>): Promise<void> {
    const result = await client.callTool({ name: tool, arguments: args });
    const envelope = envelopeOf(result);
    expect(envelope.success).toBe(false);
    expect(envelope.error?.code).toBe('CAPABILITY_DENIED');
    expect(ghInvocationLines(ghLogPath)).toEqual([]);
    const eventStore = new EventStore(join(root, 'state'));
    try {
      expect(await storedEventCount(eventStore)).toBe(0);
    } finally {
      eventStore.close();
    }
  }

  it('denies merge_pr on the production server before gh runs', async () => {
    await expectServerDenied('exarchos_orchestrate', {
      action: 'merge_pr',
      prId: '1',
      strategy: 'squash',
    });
  });

  it('denies event append on the production server before the store changes', async () => {
    await expectServerDenied('exarchos_event', {
      action: 'append',
      stream: 'reviewer-feature',
      event: { type: 'task.progressed', data: { taskId: 't1', tddPhase: 'red' } },
    });
  });
});
