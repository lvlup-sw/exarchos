/**
 * Shape tests for `.github/workflows/release.yml`.
 *
 * The tests parse the workflow with `js-yaml`, so a formatting edit does not break
 * them. They do not run `bun build --compile`. The CI `binary-matrix` job and the
 * release pipeline do that.
 *
 * The expected matrix targets and release assets come from `TARGETS`, the one list of
 * cross-compile targets. A change to `TARGETS` without a matching `release.yml` edit
 * fails here. `tests/scripts/ci-binary-matrix.test.ts` holds the same matrix shape for
 * the pull-request CI job.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { TARGETS } from '../../tools/release/build-binary-targets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
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

  /** The matrix is a `target` list of names or an `include` list of objects. The expected names come from `TARGETS`. */
  it('ReleaseWorkflow_BinaryMatrix_FiveTargets', () => {
    const wf = loadReleaseWorkflow();
    const job = wf.jobs?.['binary-matrix'];
    expect(job).toBeDefined();

    const matrix = job?.strategy?.matrix;
    expect(matrix).toBeDefined();

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

    const expectedNames = TARGETS.map((t) => `${t.os}-${t.arch}`);
    expect(names.slice().sort()).toEqual(expectedNames.slice().sort());
  });

  /**
   * The `files` lists of the gh-release steps must hold one binary and one `.sha512`
   * sidecar for each `TARGETS` entry, plus the signed release manifest. The manifest
   * pins the source and contract identity of the published bytes. The comparison
   * ignores order and rejects duplicates, because a count check accepts a wrong
   * sidecar name. Only the Windows binary has the `.exe` extension.
   */
  it('ReleaseWorkflow_UploadsBinariesAndChecksums', () => {
    const wf = loadReleaseWorkflow();
    const jobs = wf.jobs ?? {};

    const allSteps: StepShape[] = [];
    for (const job of Object.values(jobs)) {
      for (const s of job.steps ?? []) {
        allSteps.push(s);
      }
    }

    const ghReleaseSteps = allSteps.filter((s) =>
      (s.uses ?? '').startsWith('softprops/action-gh-release@'),
    );

    expect(ghReleaseSteps.length).toBeGreaterThan(0);

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

  /**
   * `js-yaml` version 4 keeps `on` as a string key, although `on` is a boolean literal
   * in YAML 1.1. The test requires the semver pattern `v*.*.*`, because `v*` also
   * matches tags that are not semver.
   */
  it('ReleaseWorkflow_TriggersOnTagPush', () => {
    const wf = loadReleaseWorkflow();
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
    expect(tagPatterns).toContain('v*.*.*');
  });

  /**
   * The release body gives the install command for each installer script. The check
   * searches the full workflow text, comments included.
   */
  it('ReleaseWorkflow_BodyMentionsBootstrapUrls', () => {
    const raw = loadReleaseWorkflowRaw();
    expect(raw).toContain('get-exarchos.sh');
    expect(raw).toContain('get-exarchos.ps1');
  });
});
