/**
 * Tests for `resolveWorkspace` and the `isExarchosWorkspace` detector.
 * The discovery priority is: an explicit `featureId`, then roots, then cwd.
 * These tests cover the roots branch and the cwd branch. No test in this file passes an explicit `featureId`.
 */

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

/**
 * Seeds a workspace with an empty `.exarchos.yml` signature and one `<featureId>.state.json` file.
 * Discovery only checks that the YAML file exists, so an empty file is sufficient.
 */
async function seedExarchosWorkspace(root: string, featureId: string): Promise<void> {
  await fs.writeFile(path.join(root, '.exarchos.yml'), '', 'utf8');
  await fs.mkdir(path.join(root, 'docs', 'workflow-state'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'docs', 'workflow-state', `${featureId}.state.json`),
    JSON.stringify({ featureId, workflowType: 'feature' }),
    'utf8',
  );
}

/**
 * Builds the `file://` URI with `pathToFileURL`.
 * A hand-built `file://` string is wrong for a Windows path, which has a drive letter and backslashes.
 */
function fileUriFor(p: string): string {
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

  /**
   * A tracked workspace can hold only the event-store db and no `.state.json` file.
   * The db file in `docs/workflow-state/` is then the workspace signature.
   */
  it('IsExarchosWorkspace_EventDbPresent_ReturnsTrue', async () => {
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
  /**
   * The workspace has the `.exarchos.yml` signature and no `.state.json` file.
   * The event store uses the `docs/workflow-state` directory of this workspace.
   * Thus `deriveFeatureId` reads `listStates()` from the storage backend, not the file scan.
   * The test passes no `rootsClient`, so discovery uses the cwd walk.
   */
  it('WorkspaceDiscovery_NoStateFileButBackendRow_ResolvesFromListStates', async () => {
    const tmp = await mktemp('backend-cwd');
    try {
      const root = path.join(tmp, 'project');
      const wfDir = path.join(root, 'docs', 'workflow-state');
      await fs.mkdir(wfDir, { recursive: true });
      await fs.writeFile(path.join(root, '.exarchos.yml'), '', 'utf8');

      const eventStore = new EventStore(wfDir);
      await eventStore.initialize();

      const storage = new InMemoryBackend();
      storage.setState('feat-from-backend', {
        featureId: 'feat-from-backend',
        workflowType: 'feature',
      } as unknown as WorkflowState);

      const resolver = createInMemoryResolver([]);
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
  /** The `workspace.resolved` event goes to the stream of the resolved `featureId`. */
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

  /** The one root is a plain directory, and the cwd is an Exarchos workspace. */
  it('WorkspaceDiscovery_ZeroRootsMatch_FallsBackToCwdWalk', async () => {
    const tmp = await mktemp('zero-root');
    try {
      const unrelated = path.join(tmp, 'unrelated');
      await fs.mkdir(unrelated, { recursive: true });

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

  /** More than one match emits no `workspace.resolved` event, because no single `featureId` owns the resolution. */
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

  /**
   * The first call fetches the roots list. The second call uses the cache, although the client now returns a different list.
   * `invalidateRootsCache()` simulates the `roots/list_changed` notification, and the third call fetches again.
   */
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

      const r1 = await resolveWorkspace({ resolver, rootsClient, cwd: tmp, eventStore });
      expect(r1?.success).toBe(true);
      expect(r1?.featureId).toBe('feat-initial');
      expect(fetchCount).toBe(1);

      nextList = [{ uri: fileUriFor(next) }];
      const r2 = await resolveWorkspace({ resolver, rootsClient, cwd: tmp, eventStore });
      expect(r2?.success).toBe(true);
      expect(r2?.featureId).toBe('feat-initial');
      expect(fetchCount).toBe(1);

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

  /**
   * The test records no handshake snapshot, so `isRootsDeclared()` is false.
   * Discovery uses the cwd walk and never calls the roots client.
   */
  it('WorkspaceDiscovery_RootsDeclaredFalse_SkipsRootsBranchEntirely', async () => {
    const tmp = await mktemp('no-decl');
    try {
      const cwd = path.join(tmp, 'project');
      await fs.mkdir(cwd, { recursive: true });
      await seedExarchosWorkspace(cwd, 'feat-cwdonly');

      const resolver = createInMemoryResolver([]);

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

