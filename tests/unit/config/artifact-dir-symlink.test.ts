/**
 * The artifact directory against real filesystem state. The tests build real symlinks, so
 * the operating system decides each expectation, not a mock of `realpathSync`.
 *
 * A directory that is a symlink out of the repository must resolve and classify.
 * A stored path must be POSIX-normalized. A missing directory must not change
 * `_meta.workflowExists`: existence is the answer of the event projection, never of a
 * filesystem stat.
 *
 * @oracle-sources: ../../../src/config/artifacts.ts, real-filesystem-symlink-state
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { handleRehydrate } from '../../../src/workflow/rehydrate.js';
import { classifyArtifactLayout } from '../../../src/workflow/rehydrate.js';
import {
  DEFAULT_SPEC_DIR,
  resolveArtifactDirPath,
  resolveArtifactDirs,
  toPosixPath,
} from '../../../src/config/artifacts.js';
import type { ToolResult } from '../../../src/format.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let repoRoot: string;
let outOfTree: string;
let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'artifact-dir-symlink-'));
  repoRoot = path.join(tempDir, 'repo');
  outOfTree = path.join(tempDir, 'elsewhere', 'specs');
  stateDir = path.join(tempDir, 'state');
  await mkdir(repoRoot, { recursive: true });
  await mkdir(outOfTree, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  store = new EventStore(stateDir);
});

/** A failed `close` must not stop the removal of the temp directory. */
afterEach(async () => {
  try {
    store.close();
  } catch {
  }
  await rmrfAsync(tempDir);
});

describe('ArtifactDir_SymlinkedOutOfTree_ResolvesAndClassifies', () => {
  it('follows a symlink that leaves the repository', async () => {
    await writeFile(path.join(outOfTree, '2026-08-11-feature.md'), '# spec\n', 'utf-8');
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
    await symlink(outOfTree, path.join(repoRoot, 'docs', 'specs'), 'dir');

    const resolved = resolveArtifactDirPath(repoRoot, DEFAULT_SPEC_DIR);

    expect(resolved).toBe(toPosixPath(realish(outOfTree)));
    expect(resolved.startsWith(toPosixPath(realish(repoRoot)))).toBe(false);
    await expect(readdir(resolved)).resolves.toEqual(['2026-08-11-feature.md']);
  });

  it('classification is unaffected by the link — it reads the artifact map, not disk', async () => {
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
    await symlink(outOfTree, path.join(repoRoot, 'docs', 'specs'), 'dir');

    expect(classifyArtifactLayout({ plan: 'docs/specs/2026-08-11-feature.md' })).toBe('unified');

    const dirs = resolveArtifactDirs({ 'spec-dir': 'docs/specs' });
    expect(classifyArtifactLayout({ plan: 'docs/specs/2026-08-11-feature.md' }, dirs)).toBe(
      'unified',
    );
  });

  it('a dangling symlink degrades to the unresolved path instead of throwing', async () => {
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
    await symlink(path.join(tempDir, 'gone'), path.join(repoRoot, 'docs', 'specs'), 'dir');

    const resolved = resolveArtifactDirPath(repoRoot, DEFAULT_SPEC_DIR);
    expect(resolved).toBe(toPosixPath(path.resolve(repoRoot, 'docs/specs')));
  });
});

describe('ArtifactDir_WindowsSeparators_IsStoredPosixNormalized', () => {
  it('normalizes backslash-authored config to the POSIX storage form (INV-16)', () => {
    const dirs = resolveArtifactDirs({
      'spec-dir': 'docs\\specs',
      'legacy-design-dir': 'docs\\designs',
    });
    expect(dirs.specDir).toBe('docs/specs/');
    expect(dirs.legacyDesignDir).toBe('docs/designs/');
    expect(dirs.specDir).not.toContain('\\');
  });

  it('a backslash-authored prefix still matches a POSIX-recorded artifact path', () => {
    const dirs = resolveArtifactDirs({ 'spec-dir': 'design\\records' });
    expect(classifyArtifactLayout({ plan: 'design/records/2026-08-11-x.md' }, dirs)).toBe('unified');
  });

  it('every resolved on-disk path is POSIX-separated', async () => {
    await mkdir(path.join(repoRoot, 'docs', 'specs'), { recursive: true });
    for (const form of ['docs/specs', 'docs\\specs', 'docs//specs', './docs/specs']) {
      expect(resolveArtifactDirPath(repoRoot, form)).not.toContain('\\');
    }
  });

  it('all separator forms of the same directory resolve to one path', async () => {
    await mkdir(path.join(repoRoot, 'docs', 'specs'), { recursive: true });
    const forms = ['docs/specs', 'docs\\specs', 'docs//specs', './docs/specs', 'docs/specs/'];
    const resolved = new Set(forms.map((f) => resolveArtifactDirPath(repoRoot, f)));
    expect(resolved.size).toBe(1);
  });
});

describe('ArtifactDir_MissingDirectory_DoesNotAffectWorkflowExistence', () => {
  it('a tracked workflow still reports workflowExists with NO artifact directory on disk', async () => {
    const featureId = 'missing-dir-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'refactor' },
    });
    await expect(readdir(path.join(repoRoot, 'docs')).catch(() => 'absent')).resolves.toBe(
      'absent',
    );

    const result = await withCwd(repoRoot, () =>
      handleRehydrate({ featureId }, { eventStore: store, stateDir }),
    );

    expect(result.success).toBe(true);
    expect(metaOf(result)['workflowExists']).toBe(true);
  });

  it('a never-started feature reports workflowExists:false even WITH the directory present', async () => {
    await mkdir(path.join(repoRoot, 'docs', 'specs'), { recursive: true });
    await writeFile(
      path.join(repoRoot, 'docs', 'specs', '2026-08-11-not-a-workflow.md'),
      '# spec\n',
      'utf-8',
    );

    const result = await handleRehydrate(
      { featureId: 'never-initialized-feature' },
      { eventStore: store, stateDir },
    );

    expect(result.success).toBe(true);
    expect(metaOf(result)['workflowExists']).toBe(false);
  });

  it('a dangling symlinked artifact directory does not change the verdict', async () => {
    const featureId = 'dangling-dir-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'refactor' },
    });
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
    await symlink(path.join(tempDir, 'gone'), path.join(repoRoot, 'docs', 'specs'), 'dir');

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });
    expect(metaOf(result)['workflowExists']).toBe(true);
  });
});

describe('Rehydrate_WorkflowInitializedBeforeChange_StillResolves', () => {
  it('a workflow recorded under the pre-DR-6 default rehydrates unchanged', async () => {
    const featureId = 'pre-dr6-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'refactor' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: { patch: { artifacts: { spec: 'docs/specs/2026-07-04-harness-conform-and-shrink.md' } } },
    });

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });

    expect(result.success).toBe(true);
    expect(metaOf(result)['workflowExists']).toBe(true);
    expect(metaOf(result)['artifactLayout']).toBe('unified');
  });

  it('a pre-collapse two-artifact workflow still completes on the old path', async () => {
    const featureId = 'pre-collapse-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: { patch: { artifacts: { design: 'docs/designs/2026-04-01-old-feature.md' } } },
    });

    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });
    expect(metaOf(result)['artifactLayout']).toBe('two-artifact');
  });

  /**
   * The context moves the spec directory to `design-records`. Thus the recorded plan path
   * is not a unified signal, and the legacy design doc decides the layout.
   */
  it('an explicitly configured directory reaches the classifier through the context', async () => {
    const featureId = 'configured-dir-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'refactor' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: { patch: { artifacts: { design: 'docs/designs/legacy.md', plan: 'docs/specs/x.md' } } },
    });

    const result = await handleRehydrate(
      { featureId },
      {
        eventStore: store,
        stateDir,
        artifactDirs: resolveArtifactDirs({ 'spec-dir': 'design-records' }),
      },
    );
    expect(metaOf(result)['artifactLayout']).toBe('two-artifact');
  });
});

/**
 * Runs `fn` with the process rooted at `dir`. It uses a real `chdir`, not a `cwd()` stub,
 * so a filesystem probe by any route lands in `dir`. Without the `chdir`, the handler never
 * sees the test repository, and the test passes for the wrong reason.
 */
async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

/** Returns `_meta` of a `ToolResult`, and fails when it is absent. */
function metaOf(result: ToolResult): Record<string, unknown> {
  const meta = (result as { _meta?: unknown })._meta;
  expect(meta, 'handler returned no _meta').toBeDefined();
  return meta as Record<string, unknown>;
}

/**
 * Resolves symlinks in an expected path with `realpathSync`, the primitive that the resolver
 * uses. macOS puts temp directories behind a `/var` symlink. On Windows the promise
 * `realpath` can return the long path where `realpathSync` returns the 8.3 form.
 */
function realish(p: string): string {
  return nodeFs.realpathSync(p);
}
