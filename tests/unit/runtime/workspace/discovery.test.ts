// ─── #1290 — Roots-based workspace discovery ─────────────────────────────────
//
// RED → GREEN coverage for `resolveWorkspace` and the pure
// `isExarchosWorkspace` detector. Discovery priority is `explicit > roots
// > cwd` — these tests pin the roots + cwd branches; the explicit branch
// is exercised at the dispatch boundary (see tests/outcome/).

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { EventStore } from '../../../../src/events/store.js';
import { InMemoryBackend } from '../../../../src/storage/memory-backend.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import type { RootsClient } from '../../../../src/runtime/workspace/discovery.js';
import { resolveWorkspace, isExarchosWorkspace } from '../../../../src/runtime/workspace/discovery.js';
import type { WorkflowState } from '../../../../src/workflow/types.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

async function mktemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `discovery-${prefix}-`));
}

async function seedExarchosWorkspace(root: string, featureId: string): Promise<void> {
  // `.exarchos.yml` is the canonical workspace signature. Empty file is
  // sufficient — the loader is not invoked here.
  await fs.writeFile(path.join(root, '.exarchos.yml'), '', 'utf8');
  await fs.mkdir(path.join(root, 'docs', 'workflow-state'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'docs', 'workflow-state', `${featureId}.state.json`),
    JSON.stringify({ featureId, workflowType: 'feature' }),
    'utf8',
  );
}

function fileUriFor(p: string): string {
  // Use `pathToFileURL` so the constructed URI is correct on both POSIX
  // and Windows (where drive letters and backslashes require escaping a
  // hand-rolled `file://` template cannot produce).
  return pathToFileURL(p).href;
}

describe('isExarchosWorkspace detector (#1290)', () => {
  it('IsExarchosWorkspace_ExarchosYmlPresent_ReturnsTrue', async () => {
    const dir = await mktemp('iexa-yml');
    try {
      await fs.writeFile(path.join(dir, '.exarchos.yml'), '', 'utf8');
      expect(isExarchosWorkspace(dir)).toBe(true);
    } finally {
      await rmrfAsync(dir);
    }
  });

  it('IsExarchosWorkspace_StateFilePresent_ReturnsTrue', async () => {
    const dir = await mktemp('iexa-state');
    try {
      await fs.mkdir(path.join(dir, 'docs', 'workflow-state'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'docs', 'workflow-state', 'feat.state.json'),
        '{}',
        'utf8',
      );
      expect(isExarchosWorkspace(dir)).toBe(true);
    } finally {
      await rmrfAsync(dir);
    }
  });

  it('IsExarchosWorkspace_PlainDir_ReturnsFalse', async () => {
    const dir = await mktemp('iexa-plain');
    try {
      expect(isExarchosWorkspace(dir)).toBe(false);
    } finally {
      await rmrfAsync(dir);
    }
  });

  it('IsExarchosWorkspace_EventDbPresent_ReturnsTrue', async () => {
    // #1504 — once the write-path is removed a tracked workspace may carry NO
    // `.state.json`, only the event-store SQLite db. The detector must still
    // recognize it via the db file under `docs/workflow-state/`.
    const dir = await mktemp('iexa-db');
    try {
      await fs.mkdir(path.join(dir, 'docs', 'workflow-state'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'docs', 'workflow-state', 'exarchos.db'),
        '',
        'utf8',
      );
      expect(isExarchosWorkspace(dir)).toBe(true);
    } finally {
      await rmrfAsync(dir);
    }
  });
});

describe('resolveWorkspace backend-first featureId derivation (#1504)', () => {
  it('WorkspaceDiscovery_NoStateFileButBackendRow_ResolvesFromListStates', async () => {
    // The workspace has the `.exarchos.yml` signature but NO `*.state.json`
    // (write-path removed). `deriveFeatureId` must enumerate the authoritative
    // `workflow_state` projection via the storage backend rather than the
    // (now absent) file scan — guarded by the probed workflow-state dir
    // matching the event store's dir.
    const tmp = await mktemp('backend-cwd');
    try {
      const root = path.join(tmp, 'project');
      const wfDir = path.join(root, 'docs', 'workflow-state');
      await fs.mkdir(wfDir, { recursive: true });
      await fs.writeFile(path.join(root, '.exarchos.yml'), '', 'utf8');

      // Event store bound to THIS workspace's workflow-state dir so the
      // backend guard (wfdir === eventStore.dir) matches.
      const eventStore = new EventStore(wfDir);
      await eventStore.initialize();

      const storage = new InMemoryBackend();
      storage.setState('feat-from-backend', {
        featureId: 'feat-from-backend',
        workflowType: 'feature',
      } as unknown as WorkflowState);

      const resolver = createInMemoryResolver([]);
      // No rootsClient → discovery skips the roots branch and uses cwd-walk.
      const result = await resolveWorkspace({
        resolver,
        cwd: root,
        eventStore,
        storage,
      });

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.source).toBe('cwd');
      expect(result!.featureId).toBe('feat-from-backend');
    } finally {
      await rmrfAsync(tmp);
    }
  });
});

describe('resolveWorkspace roots branch (#1290)', () => {
  it('WorkspaceDiscovery_OneRootsMatch_ResolvesAndEmitsEvent', async () => {
    const tmp = await mktemp('one-root');
    try {
      const root = path.join(tmp, 'project');
      await fs.mkdir(root, { recursive: true });
      await seedExarchosWorkspace(root, 'feat-alpha');

      const resolver = createInMemoryResolver([]);
      resolver.snapshot({ capabilities: { roots: { listChanged: true } } });

      const rootsClient: RootsClient = {
        async list() {
          return [{ uri: fileUriFor(root) }];
        },
      };

      const stateDir = await mktemp('one-root-state');
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();

      const result = await resolveWorkspace({
        resolver,
        rootsClient,
        cwd: tmp,
        eventStore,
      });

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.source).toBe('roots');
      expect(result!.featureId).toBe('feat-alpha');
      expect(result!.path).toBe(root);

      // `workspace.resolved` event landed on the resolved featureId's stream.
      const events = await eventStore.query('feat-alpha');
      const evt = events.find((e) => e.type === 'workspace.resolved');
      expect(evt).toBeDefined();
      const data = evt!.data as { source?: string; featureId?: string; path?: string };
      expect(data.source).toBe('roots');
      expect(data.featureId).toBe('feat-alpha');
      expect(data.path).toBe(root);

      await rmrfAsync(stateDir);
    } finally {
      await rmrfAsync(tmp);
    }
  });

  it('WorkspaceDiscovery_ZeroRootsMatch_FallsBackToCwdWalk', async () => {
    const tmp = await mktemp('zero-root');
    try {
      // Roots contain a non-exarchos dir.
      const unrelated = path.join(tmp, 'unrelated');
      await fs.mkdir(unrelated, { recursive: true });

      // cwd is itself an exarchos workspace.
      const cwd = path.join(tmp, 'project');
      await fs.mkdir(cwd, { recursive: true });
      await seedExarchosWorkspace(cwd, 'feat-cwd');

      const resolver = createInMemoryResolver([]);
      resolver.snapshot({ capabilities: { roots: { listChanged: true } } });

      const rootsClient: RootsClient = {
        async list() {
          return [{ uri: fileUriFor(unrelated) }];
        },
      };

      const stateDir = await mktemp('zero-root-state');
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();

      const result = await resolveWorkspace({
        resolver,
        rootsClient,
        cwd,
        eventStore,
      });

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.source).toBe('cwd');
      expect(result!.featureId).toBe('feat-cwd');
      expect(result!.path).toBe(cwd);

      const events = await eventStore.query('feat-cwd');
      const evt = events.find((e) => e.type === 'workspace.resolved');
      expect(evt).toBeDefined();
      expect((evt!.data as { source?: string }).source).toBe('cwd');

      await rmrfAsync(stateDir);
    } finally {
      await rmrfAsync(tmp);
    }
  });

  it('WorkspaceDiscovery_ZeroRootsAndCwdMiss_ReturnsUndefined', async () => {
    const tmp = await mktemp('all-miss');
    try {
      const cwd = path.join(tmp, 'nothing');
      await fs.mkdir(cwd, { recursive: true });

      const resolver = createInMemoryResolver([]);
      resolver.snapshot({ capabilities: { roots: { listChanged: true } } });

      const rootsClient: RootsClient = {
        async list() {
          return [];
        },
      };

      const stateDir = await mktemp('all-miss-state');
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();

      const result = await resolveWorkspace({
        resolver,
        rootsClient,
        cwd,
        eventStore,
      });

      expect(result).toBeUndefined();
      await rmrfAsync(stateDir);
    } finally {
      await rmrfAsync(tmp);
    }
  });

  it('WorkspaceDiscovery_MultipleRootsMatch_ReturnsInvalidInputWithValidTargets', async () => {
    const tmp = await mktemp('multi');
    try {
      const a = path.join(tmp, 'a');
      const b = path.join(tmp, 'b');
      await fs.mkdir(a, { recursive: true });
      await fs.mkdir(b, { recursive: true });
      await seedExarchosWorkspace(a, 'feat-a');
      await seedExarchosWorkspace(b, 'feat-b');

      const resolver = createInMemoryResolver([]);
      resolver.snapshot({ capabilities: { roots: { listChanged: true } } });

      const rootsClient: RootsClient = {
        async list() {
          return [{ uri: fileUriFor(a) }, { uri: fileUriFor(b) }];
        },
      };

      const stateDir = await mktemp('multi-state');
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();

      const result = await resolveWorkspace({
        resolver,
        rootsClient,
        cwd: tmp,
        eventStore,
      });

      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
      expect(result!.code).toBe('INVALID_INPUT');
      expect(result!.validTargets).toBeDefined();
      expect(result!.validTargets!.length).toBe(2);

      const paths = result!.validTargets!.map((t) => t.path).sort();
      expect(paths).toEqual([a, b].sort());

      // No event emitted on multi-match — there is no single featureId to
      // attribute the resolution to.
      const a_events = await eventStore.query('feat-a');
      const b_events = await eventStore.query('feat-b');
      const resolved = [...a_events, ...b_events].filter(
        (e) => e.type === 'workspace.resolved',
      );
      expect(resolved.length).toBe(0);

      await rmrfAsync(stateDir);
    } finally {
      await rmrfAsync(tmp);
    }
  });

  it('WorkspaceDiscovery_RootsListChangedDuringDispatch_InvalidatesCache', async () => {
    const tmp = await mktemp('cache');
    try {
      const initial = path.join(tmp, 'initial');
      const next = path.join(tmp, 'next');
      await fs.mkdir(initial, { recursive: true });
      await fs.mkdir(next, { recursive: true });
      await seedExarchosWorkspace(initial, 'feat-initial');
      await seedExarchosWorkspace(next, 'feat-next');

      const resolver = createInMemoryResolver([]);
      resolver.snapshot({ capabilities: { roots: { listChanged: true } } });

      let fetchCount = 0;
      let nextList: { uri: string }[] = [{ uri: fileUriFor(initial) }];
      const rootsClient: RootsClient = {
        async list() {
          fetchCount += 1;
          return nextList;
        },
      };

      const stateDir = await mktemp('cache-state');
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();

      // First call: cache miss → fetch.
      const r1 = await resolveWorkspace({ resolver, rootsClient, cwd: tmp, eventStore });
      expect(r1?.success).toBe(true);
      expect(r1?.featureId).toBe('feat-initial');
      expect(fetchCount).toBe(1);

      // Second call: cache hit → no additional fetch. Even if the
      // underlying fixture changes the rootsClient response, the cached
      // entry must win until invalidation.
      nextList = [{ uri: fileUriFor(next) }];
      const r2 = await resolveWorkspace({ resolver, rootsClient, cwd: tmp, eventStore });
      expect(r2?.success).toBe(true);
      expect(r2?.featureId).toBe('feat-initial');
      expect(fetchCount).toBe(1);

      // Simulate `roots/list_changed` notification → cache invalidated.
      resolver.invalidateRootsCache();

      const r3 = await resolveWorkspace({ resolver, rootsClient, cwd: tmp, eventStore });
      expect(r3?.success).toBe(true);
      expect(r3?.featureId).toBe('feat-next');
      expect(fetchCount).toBe(2);

      await rmrfAsync(stateDir);
    } finally {
      await rmrfAsync(tmp);
    }
  });

  it('WorkspaceDiscovery_RootsDeclaredFalse_SkipsRootsBranchEntirely', async () => {
    const tmp = await mktemp('no-decl');
    try {
      const cwd = path.join(tmp, 'project');
      await fs.mkdir(cwd, { recursive: true });
      await seedExarchosWorkspace(cwd, 'feat-cwdonly');

      const resolver = createInMemoryResolver([]);
      // Note: NO snapshot call → isRootsDeclared() is false.

      let fetchCount = 0;
      const rootsClient: RootsClient = {
        async list() {
          fetchCount += 1;
          return [{ uri: fileUriFor(cwd) }];
        },
      };

      const stateDir = await mktemp('no-decl-state');
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();

      const result = await resolveWorkspace({
        resolver,
        rootsClient,
        cwd,
        eventStore,
      });

      // Resolution falls back to cwd-walk. rootsClient is never called.
      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.source).toBe('cwd');
      expect(result!.featureId).toBe('feat-cwdonly');
      expect(fetchCount).toBe(0);

      await rmrfAsync(stateDir);
    } finally {
      await rmrfAsync(tmp);
    }
  });
});

