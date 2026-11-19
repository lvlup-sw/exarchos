/** A private checkout and a real store for the bootstrap integration tests. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../src/events/store.js';
import type { ToolResult } from '../../../src/format.js';
import { handlePrepare, type PrepareDeps } from '../../../src/verbs/prepare/handler.js';
import type { PreparedCapsuleReceipt } from '../../../src/verbs/prepare/types.js';
import { createInMemoryResolver } from '../../../src/workflow/capabilities/resolver.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { task, textOf } from './prepared-authority.js';

export const STREAM = 'bootstrap-integration';
export const BASE = 'codex/integration';
export const REF = 'design.md';
const CAPS = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos'];
const STAMP = '2026-11-13T00:00:00.000Z';

export function planText(size = 1): string {
  return textOf(Array.from({ length: size }, (_, index) =>
    task(`task-${index}`, { testFiles: [`tests/task-${index}.test.ts`] })));
}

export async function bootstrapFixture(cleanup: (() => Promise<void> | void)[], text = planText()) {
  const root = makeTempDir('prepare-bootstrap-');
  cleanup.push(() => rmrfAsync(root));
  const checkout = path.join(root, 'checkout');
  const stateDir = path.join(root, 'state');
  const stateFile = path.join(stateDir, `${STREAM}.state.json`);
  const write = (contents: string, ref = REF) => writeFile(path.join(checkout, ref), contents);
  await mkdir(checkout);
  await write(JSON.stringify({ scripts: { lint: 'true', typecheck: 'true', 'test:files': 'true', 'test:run': 'true' } }), 'package.json');
  await write(text);
  const events = new EventStore(stateDir);
  await events.initialize();
  cleanup.push(() => events.close());
  const backend = events.getAppender().ensureSqliteBackendSync();
  let commit = 'a'.repeat(40);
  const observe = vi.fn(async () => ({ kind: 'repository' as const, toplevel: checkout, repository: path.join(checkout, '.git') }));
  const commitOf = vi.fn(async (_checkout: string, ref: string) =>
    ref.startsWith('refs/tags/') ? { kind: 'absent' as const } : { kind: 'commit' as const, commit });
  const deps: PrepareDeps = {
    now: () => STAMP,
    catalogInvariants: () => [],
    scopeGit: { observe, commitOf, isAncestor: async () => ({ kind: 'ancestor' }) },
  };
  const context: DispatchContext = { stateDir, eventStore: events, enableTelemetry: false };
  const intent = (source = text, overrides: Record<string, unknown> = {}) => ({
    mode: 'bootstrap', workflowType: 'feature', baseRef: BASE, designRef: REF,
    approval: { decision: 'approved', designDigest: createHash('sha256').update(source).digest('hex') },
    ...overrides,
  });
  const call = (terms: unknown = intent(), overrides: PrepareDeps = {}, raw: Record<string, unknown> = {}) => {
    const identity = deriveMcpCallerIdentity({ sessionId: STREAM });
    const dispatch = mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPS)));
    return runWithDispatchContext(dispatch, () => handlePrepare(
      { streamId: STREAM, repoRoot: checkout, intent: terms, ...raw }, stateDir, context, { ...deps, ...overrides },
    ));
  };
  return {
    root, checkout, stateDir, stateFile, events, backend, observe, commitOf, context, deps, intent, call, write,
    setHead(value: string) { commit = value; },
  };
}

export type BootstrapFixture = Awaited<ReturnType<typeof bootstrapFixture>>;

export function receipt(result: ToolResult): PreparedCapsuleReceipt {
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return result.data as PreparedCapsuleReceipt;
}
