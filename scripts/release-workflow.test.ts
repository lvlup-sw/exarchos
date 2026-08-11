/**
 * Release workflow shape tests (task 2.7).
 *
 * Phase progression: RED (assertions added, failing against the pre-2.7
 * release.yml which only does an npm publish) → GREEN (release.yml gains a
 * `binary-matrix` build job + a `publish-release` upload job that publishes
 * 10 assets — 5 binaries plus 5 .sha512 sidecars — to the GitHub Release on
 * tag push) → REFACTOR (matrix provenance comment cross-referenced with
 * `scripts/build-binary.ts`).
 *
 * These assertions parse `.github/workflows/release.yml` with `js-yaml`
 * rather than regex-matching so reasonable formatting edits don't break
 * the gate. The parent task's "adversarial verification posture" rules
 * require hard structural checks, not grep.
 *
 * Scope: structural shape only. We do not invoke `bun build --compile`
 * here — that is exercised by the CI binary-matrix job per PR and by the
 * actual release pipeline on tag push.
 *
 * Companion to `scripts/ci-binary-matrix.test.ts`, which enforces the
 * same matrix shape for the per-PR CI job.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
// Same side-effect-free targets module `ci-binary-matrix.test.ts` imports —
// the single source of truth for the cross-compile population. Deriving
// against it here closes the gap DR-8 named: before this, both the workflow's
// literal asset counts AND this test's expectations were transcribed from
// TARGETS by hand, so a drifted TARGETS left everything green.
import { TARGETS } from './build-binary-targets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const RELEASE_WORKFLOW_PATH = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'release.yml',
);

interface StepShape {
  uses?: string;
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface JobShape {
  needs?: string | string[];
  strategy?: {
    matrix?: Record<string, unknown>;
  };
  steps?: StepShape[];
}

interface WorkflowShape {
  on?:
    | string
    | string[]
    | {
        push?: { tags?: string[] };
        [k: string]: unknown;
      };
  jobs?: Record<string, JobShape>;
}

function loadReleaseWorkflow(): WorkflowShape {
  const raw = readFileSync(RELEASE_WORKFLOW_PATH, 'utf-8');
  return yaml.load(raw) as WorkflowShape;
}

function loadReleaseWorkflowRaw(): string {
  return readFileSync(RELEASE_WORKFLOW_PATH, 'utf-8');
}

describe('Release workflow (task 2.7)', () => {
  it('ReleaseWorkflow_HasBinaryMatrixJob', () => {
    const wf = loadReleaseWorkflow();
    expect(wf.jobs).toBeDefined();
    expect(wf.jobs?.['binary-matrix']).toBeDefined();
  });

  it('ReleaseWorkflow_BinaryMatrix_FiveTargets', () => {
    const wf = loadReleaseWorkflow();
    const job = wf.jobs?.['binary-matrix'];
    expect(job).toBeDefined();

    const matrix = job?.strategy?.matrix;
    expect(matrix).toBeDefined();

    // Accept either a `target:` list or an `include:` list of objects.
    const targetList = (matrix as Record<string, unknown>)['target'];
    const includeList = (matrix as Record<string, unknown>)['include'];

    const entries: unknown[] = Array.isArray(targetList)
      ? targetList
      : Array.isArray(includeList)
        ? includeList
        : [];

    const names = entries.map((e) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object' && 'target' in e) {
        return String((e as { target: unknown }).target);
      }
      return '';
    });

    // Derived from `TARGETS` (same pattern as `ci-binary-matrix.test.ts`)
    // rather than a hand-transcribed count and name list — a target added to
    // or removed from `TARGETS` without a matching `release.yml` edit reddens
    // here instead of leaving both sides as agreeing literals.
    const expectedNames = TARGETS.map((t) => `${t.os}-${t.arch}`);
    expect(names.slice().sort()).toEqual(expectedNames.slice().sort());
  });

  it('ReleaseWorkflow_UploadsBinariesAndChecksums', () => {
    const wf = loadReleaseWorkflow();
    const jobs = wf.jobs ?? {};

    // The release pipeline must attach one binary + one .sha512 sidecar per
    // `TARGETS` entry. Counting only the total length would let a typo slip
    // through (e.g. uploading `.sha256` sidecars or duplicate paths still
    // summing to the right count), so assert the exact path set instead.
    const allSteps: StepShape[] = [];
    for (const job of Object.values(jobs)) {
      for (const s of job.steps ?? []) {
        allSteps.push(s);
      }
    }

    const ghReleaseSteps = allSteps.filter((s) =>
      (s.uses ?? '').startsWith('softprops/action-gh-release@'),
    );

    // At least one publish mechanism must be present.
    expect(ghReleaseSteps.length).toBeGreaterThan(0);

    // Collect `files:` entries from every gh-release step (string or
    // YAML-list shape), then assert membership against the known list.
    const advertisedAssets: string[] = [];
    for (const step of ghReleaseSteps) {
      const files = step.with?.['files'];
      if (typeof files === 'string') {
        for (const line of files.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length > 0 && !trimmed.startsWith('#')) {
            advertisedAssets.push(trimmed);
          }
        }
      } else if (Array.isArray(files)) {
        for (const f of files) advertisedAssets.push(String(f).trim());
      }
    }

    // Two-sided check: exact set membership + no duplicates. The order
    // in `release.yml` is {binary, .sha512} per target, but this
    // assertion is order-independent so reasonable reorderings don't
    // break the gate while typos still do.
    //
    // DR-20 added the signed release manifest
    // (`exarchos-release-manifest.json`), produced by
    // `scripts/build-release-manifest.ts` over the exact published bytes.
    // Unlike the unsigned `.sha512` sidecars it also pins the source and
    // contract identity, so it must never silently drop out of `files:`.
    //
    // The per-target pair is DERIVED from `TARGETS` rather than transcribed —
    // this is the DR-8 fix: before, `release.yml`'s own asset count and this
    // expected list were BOTH literals copied from the same population, so a
    // target added to `TARGETS` without a matching `release.yml` edit stayed
    // green here. Windows carries the `.exe` extension convention `build-
    // binary.ts` uses; every other target has none.
    const expectedAssets = [
      ...TARGETS.flatMap((t) => {
        const ext = t.os === 'windows' ? '.exe' : '';
        const binary = `dist/release/exarchos-${t.os}-${t.arch}${ext}`;
        return [binary, `${binary}.sha512`];
      }),
      'dist/release/exarchos-release-manifest.json',
    ];
    expect(advertisedAssets.slice().sort()).toEqual(expectedAssets.slice().sort());
    expect(new Set(advertisedAssets).size).toBe(advertisedAssets.length);
  });

  it('ReleaseWorkflow_TriggersOnTagPush', () => {
    const wf = loadReleaseWorkflow();
    // js-yaml preserves the string key `on` in v4, so a direct property
    // lookup works here even though `on` is a YAML 1.1 boolean literal.
    const on = wf.on;
    expect(on).toBeDefined();

    if (typeof on !== 'object' || Array.isArray(on) || on === null) {
      throw new Error('release.yml `on` must be a mapping with push.tags');
    }

    const pushTrigger = (on as { push?: { tags?: unknown } }).push;
    expect(pushTrigger).toBeDefined();

    const tags = pushTrigger?.tags;
    expect(Array.isArray(tags)).toBe(true);

    const tagPatterns = Array.isArray(tags) ? tags.map(String) : [];
    // The specific `v*.*.*` semver shape is required by task 2.7 — the
    // broader `v*` accepts non-semver refs and is intentionally weaker.
    expect(tagPatterns).toContain('v*.*.*');
  });

  it('ReleaseWorkflow_BodyMentionsBootstrapUrls', () => {
    const raw = loadReleaseWorkflowRaw();
    // The release body template must advertise both bootstrap scripts so
    // end-users copy/paste install snippets from the Release page itself.
    expect(raw).toContain('get-exarchos.sh');
    expect(raw).toContain('get-exarchos.ps1');
  });
});
