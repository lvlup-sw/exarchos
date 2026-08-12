import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import { handleRehydrate } from '../workflow/rehydrate.js';
import { classifyArtifactLayout } from '../workflow/rehydrate.js';
import {
  DEFAULT_SPEC_DIR,
  resolveArtifactDirPath,
  resolveArtifactDirs,
  toPosixPath,
} from './artifacts.js';
import type { ToolResult } from '../format.js';

// ─── Artifact directory: symlinks, separators, and existence (DR-6, DR-11) ───
//
// The docs exodus mounts the artifact directory as a SYMLINK pointing outside
// the repository. Three properties have to survive that, and each is checked
// against real filesystem state rather than a mock, because the failure modes
// here are all "the real FS behaves differently than the model of it":
//
//   1. A symlinked-out-of-tree directory still resolves and still classifies.
//   2. A path is stored POSIX-normalized whatever separator form it arrived in.
//   3. A MISSING artifact directory does not change `_meta.workflowExists`.
//
// (3) is the load-bearing one. Existence is the event projection's answer, never
// a filesystem stat — the rule `docs/rca/2026-05-30-state-source-integrity.md`
// exists to protect. A configured directory that is absent or dangling must be
// invisible to that question.
//
// Authored here, beside the code, rather than at the plan's `tests/integration/`
// path: no vitest project collects `tests/integration/**`, so a test there would
// pass by never executing — and this one needs the MCP workspace's `bun:sqlite`
// alias to construct an EventStore at all.

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

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('ArtifactDir_SymlinkedOutOfTree_ResolvesAndClassifies', () => {
  it('follows a symlink that leaves the repository', async () => {
    // GIVEN: docs/specs inside the repo is a symlink to a directory outside it,
    //   holding a real spec — the shape the docs exodus produces.
    await writeFile(path.join(outOfTree, '2026-08-11-feature.md'), '# spec\n', 'utf-8');
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
    await symlink(outOfTree, path.join(repoRoot, 'docs', 'specs'), 'dir');

    // WHEN: we resolve the configured directory to its on-disk location.
    const resolved = resolveArtifactDirPath(repoRoot, DEFAULT_SPEC_DIR);

    // THEN: it lands on the out-of-tree target, not the link, and the spec is
    //   readable through it.
    expect(resolved).toBe(toPosixPath(await realish(outOfTree)));
    expect(resolved.startsWith(toPosixPath(await realish(repoRoot)))).toBe(false);
    await expect(readdir(resolved)).resolves.toEqual(['2026-08-11-feature.md']);
  });

  it('classification is unaffected by the link — it reads the artifact map, not disk', async () => {
    await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
    await symlink(outOfTree, path.join(repoRoot, 'docs', 'specs'), 'dir');

    // The recorded path stays repo-relative regardless of where the directory
    // physically lives, so the prefix match is untouched by the indirection.
    expect(classifyArtifactLayout({ plan: 'docs/specs/2026-08-11-feature.md' })).toBe('unified');

    // And a project whose configured dir is itself the symlink name classifies
    // identically — the link is a storage detail, not a classification input.
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
    // GIVEN: a workflow that genuinely exists in the event store, and a repo
    //   with no docs/specs directory at all.
    const featureId = 'missing-dir-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'refactor' },
    });
    await expect(readdir(path.join(repoRoot, 'docs')).catch(() => 'absent')).resolves.toBe(
      'absent',
    );

    // WHEN: we rehydrate with the process rooted at that artifact-less repo.
    //   Pinning cwd is what gives this test teeth: a regression that reached for
    //   the filesystem would reach for it exactly here (the composite resolves
    //   config from `process.cwd()`), and would find no artifact directory.
    //   Without the pin the handler never sees `repoRoot` at all and the test
    //   passes for the wrong reason.
    const result = await withCwd(repoRoot, () =>
      handleRehydrate({ featureId }, { eventStore: store, stateDir }),
    );

    // THEN: existence comes from the projection, untouched by the absent dir.
    expect(result.success).toBe(true);
    expect(metaOf(result)['workflowExists']).toBe(true);
  });

  it('a never-started feature reports workflowExists:false even WITH the directory present', async () => {
    // The mirror image: a real directory full of specs must not conjure a
    // workflow. Existence is not a filesystem property in either direction.
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
    // GIVEN: a workflow whose artifacts were stamped when docs/specs/ was a
    //   module literal — i.e. every workflow that exists today.
    const featureId = 'pre-dr6-feature';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'refactor' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: { patch: { artifacts: { spec: 'docs/specs/2026-07-04-harness-conform-and-shrink.md' } } },
    });

    // WHEN: it rehydrates under the new configured-directory code path with no
    //   `artifacts:` block configured — the upgrade-in-place case.
    const result = await handleRehydrate({ featureId }, { eventStore: store, stateDir });

    // THEN: it resolves, and classifies exactly as it did before.
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

    // With specs relocated, `docs/specs/x.md` is no longer a unified signal, so
    // the legacy design doc wins — proving the injected value is what decides,
    // not a literal baked into the classifier.
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
 * Run `fn` with the process rooted at `dir`. Real `chdir`, not a `cwd()` stub,
 * so a filesystem probe reached by any route — `process.cwd()`, a relative
 * `fs` call, a config walk — lands in the artifact-less repo.
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

/** `_meta` off a ToolResult, without an `any` cast. */
function metaOf(result: ToolResult): Record<string, unknown> {
  const meta = (result as { _meta?: unknown })._meta;
  expect(meta, 'handler returned no _meta').toBeDefined();
  return meta as Record<string, unknown>;
}

/**
 * macOS puts temp dirs behind a `/var` → `/private/var` symlink, so an expected
 * path built with `path.join` needs the same realpath treatment as the value
 * under test or the comparison fails for a reason unrelated to the property.
 */
async function realish(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(p);
}
