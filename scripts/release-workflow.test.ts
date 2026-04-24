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
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

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

    expect(entries.length).toBe(5);

    const names = entries.map((e) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object' && 'target' in e) {
        return String((e as { target: unknown }).target);
      }
      return '';
    });

    expect(names).toContain('linux-x64');
    expect(names).toContain('linux-arm64');
    expect(names).toContain('darwin-x64');
    expect(names).toContain('darwin-arm64');
    expect(names).toContain('windows-x64');
  });

  it('ReleaseWorkflow_UploadsBinariesAndChecksums', () => {
    const wf = loadReleaseWorkflow();
    const jobs = wf.jobs ?? {};

    // The release pipeline must attach 10 assets to the GitHub Release:
    // 5 binaries + 5 .sha512 sidecar files. We accept either a
    // softprops/action-gh-release step (with a 10-entry `files` list) or
    // an equivalent actions/upload-release-asset fan-out.
    //
    // We parse across all jobs because the publish step may live in a
    // dedicated `publish-release` job that consumes matrix artifacts.
    const allSteps: StepShape[] = [];
    for (const job of Object.values(jobs)) {
      for (const s of job.steps ?? []) {
        allSteps.push(s);
      }
    }

    const ghReleaseSteps = allSteps.filter((s) =>
      (s.uses ?? '').startsWith('softprops/action-gh-release@'),
    );
    const uploadAssetSteps = allSteps.filter((s) =>
      (s.uses ?? '').startsWith('actions/upload-release-asset@'),
    );

    // At least one publish mechanism must be present.
    expect(ghReleaseSteps.length + uploadAssetSteps.length).toBeGreaterThan(0);

    // Count advertised asset paths. softprops/action-gh-release accepts
    // `files:` as a newline-delimited string or a YAML list.
    let assetCount = 0;

    for (const step of ghReleaseSteps) {
      const files = step.with?.['files'];
      if (typeof files === 'string') {
        // Newline-delimited. Filter blanks/comments.
        const lines = files
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#'));
        assetCount += lines.length;
      } else if (Array.isArray(files)) {
        assetCount += files.length;
      }
    }

    assetCount += uploadAssetSteps.length;

    // 5 binaries + 5 .sha512 sidecars.
    expect(assetCount).toBe(10);
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
