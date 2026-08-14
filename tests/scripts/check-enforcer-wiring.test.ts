/**
 * Self-tests for the enforcer-wiring gate (task 011, DR-5 / DR-8).
 *
 * The gate models FOUR trap classes a name-grep is blind to. A grep can prove a
 * `scripts/check-*` gate EXISTS; only a transitive walk of npm-script chains +
 * workflow run-steps (inspecting per-term exit-code handling) can prove it is
 * WIRED so a real regression fails CI. Each trap class gets ONE synthetic
 * fixture that the gate MUST reject:
 *
 *   1. orphan               — EnforcerWiring_OrphanScript_Fails
 *   2. unreachable-npm      — EnforcerWiring_ReachableOnlyViaUninvokedNpmScript_Fails
 *   3. exit-code-swallowed  — EnforcerWiring_ExitCodeSwallowedByOrTrue_Fails
 *   4. missing-synchronize  — EnforcerWiring_DiffDependentGateWithoutSynchronize_Fails
 *
 * A conforming synthetic tree AND the real repository tree must both PASS.
 *
 * The gate is authored as ESM `.mjs`; NodeNext resolution requires the explicit
 * extension at import time.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// No .d.ts for this .mjs gate, but `allowJs` infers one from the source.
import {
  audit,
  analyzeCommandRefs,
  reachPrimariesFromCommand,
  parseWorkflow,
  enumeratePrimaryFiles,
} from '../../tools/audit/gates/check-enforcer-wiring.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ─── Synthetic conforming baseline (deep-cloned per test) ───────────────────
//
// - scripts/check-alpha.mjs   → gating, wired directly + failable in ci.yml
// - scripts/lint-advisory.mjs → advisory, reachable-but-neutered (`|| true`)
//   through `skills:guard`-shaped chain, exactly like the real lint-inv6.

const CI_YML = [
  'name: CI',
  'on:',
  '  pull_request:',
  'jobs:',
  '  gate:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - run: node scripts/check-alpha.mjs',
  '      - run: npm run guard',
  '',
].join('\n');

/** The gate's own entry shape, taken from its JSDoc typedef rather than restated. */
type ManifestEntry = import('../../tools/audit/gates/check-enforcer-wiring.mjs').ManifestEntry;

interface AuditInput {
  manifest: { primaries: ManifestEntry[] };
  scripts: Record<string, string>;
  workflows: Record<string, string>;
  primaryFiles: string[];
}

// Annotated rather than asserted. The three `as` casts this replaces were what
// widened `disposition` to `string` and made the fixture stop matching the very
// signature it feeds — the assertion silenced the mismatch it caused.
function baseline(): AuditInput {
  return {
    manifest: {
      primaries: [
        {
          script: 'scripts/check-alpha.mjs',
          disposition: 'gating',
          workflow: '.github/workflows/ci.yml',
          diffDependent: false,
          rationale: 'wired directly in the CI gate job',
        },
        {
          script: 'scripts/lint-advisory.mjs',
          disposition: 'advisory',
          workflow: '.github/workflows/ci.yml',
          rationale: 'neutered by design via `|| true` in the guard chain',
        },
      ],
    },
    scripts: {
      guard: 'node dist/x.js && (npm run lint:advisory || true) && npm run other',
      'lint:advisory': 'node scripts/lint-advisory.mjs content/',
      other: 'echo ok',
    },
    workflows: {
      '.github/workflows/ci.yml': CI_YML,
    },
    primaryFiles: ['scripts/check-alpha.mjs', 'scripts/lint-advisory.mjs'],
  };
}

describe('enforcer-wiring gate — conforming trees pass', () => {
  it('EnforcerWiring_ConformingSyntheticTree_Passes', () => {
    const result = audit(baseline());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('EnforcerWiring_ConformingTree_Passes (real repo)', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'tools', 'audit', 'gates', 'enforcer-wiring-manifest.json'), 'utf8'),
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const wfDir = path.join(REPO_ROOT, '.github', 'workflows');
    const workflows: Record<string, string> = {};
    for (const name of fs.readdirSync(wfDir)) {
      if (!/\.ya?ml$/.test(name)) continue;
      workflows[`.github/workflows/${name}`] = fs.readFileSync(path.join(wfDir, name), 'utf8');
    }
    const primaryFiles = enumeratePrimaryFiles(path.join(REPO_ROOT, 'tools', 'audit', 'gates'));

    const result = audit({ manifest, scripts: pkg.scripts, workflows, primaryFiles });
    // Surface any drift verbatim so a failure names the offending primary.
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('enforcer-wiring gate — trap-class fixtures (each MUST fail)', () => {
  it('EnforcerWiring_OrphanScript_Fails', () => {
    // Class 1: a gating primary that no workflow / npm chain references at all.
    const t = baseline();
    t.primaryFiles.push('scripts/check-orphan.mjs');
    t.manifest.primaries.push({
      script: 'scripts/check-orphan.mjs',
      disposition: 'gating',
      workflow: '.github/workflows/ci.yml',
      diffDependent: false,
      rationale: 'claims to gate but is wired nowhere',
    });

    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(/scripts\/check-orphan\.mjs\s+\[orphan\]/);
  });

  it('EnforcerWiring_ReachableOnlyViaUninvokedNpmScript_Fails', () => {
    // Class 2: referenced only from an npm script (`validate`) that no workflow
    // invokes — the exact real defect for check-prefix-fingerprint/prose-lint.
    const t = baseline();
    t.primaryFiles.push('scripts/check-validateonly.mjs');
    t.scripts.validate = 'node scripts/check-validateonly.mjs';
    t.manifest.primaries.push({
      script: 'scripts/check-validateonly.mjs',
      disposition: 'gating',
      workflow: '.github/workflows/ci.yml',
      diffDependent: false,
      rationale: 'wired only into the uninvoked `npm run validate`',
    });

    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(
      /scripts\/check-validateonly\.mjs\s+\[unreachable-npm\]/,
    );
  });

  it('EnforcerWiring_ExitCodeSwallowedByOrTrue_Fails', () => {
    // Class 3: runs in CI but its exit is eaten by `|| true` in the npm chain —
    // reachable yet never able to fail. (Same shape as lint-inv6, but declared
    // gating rather than advisory, so the swallow is a lie.)
    const t = baseline();
    t.primaryFiles.push('scripts/check-neutered.mjs');
    t.scripts['guard:neutered'] = '(npm run run-neutered || true)';
    t.scripts['run-neutered'] = 'node scripts/check-neutered.mjs';
    // Add a CI step that invokes the neutering chain.
    const ciYml = t.workflows['.github/workflows/ci.yml'];
    if (ciYml === undefined) throw new Error('the baseline tree must carry ci.yml');
    t.workflows['.github/workflows/ci.yml'] = ciYml.replace(
      '      - run: npm run guard\n',
      '      - run: npm run guard\n      - run: npm run guard:neutered\n',
    );
    t.manifest.primaries.push({
      script: 'scripts/check-neutered.mjs',
      disposition: 'gating',
      workflow: '.github/workflows/ci.yml',
      diffDependent: false,
      rationale: 'claims to gate but its exit code is swallowed by `|| true`',
    });

    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(
      /scripts\/check-neutered\.mjs\s+\[exit-code-swallowed\]/,
    );
  });

  it('EnforcerWiring_DiffDependentGateWithoutSynchronize_Fails', () => {
    // Class 4: wired + failable, but hosted in a workflow whose pull_request
    // trigger omits `synchronize`, so a diff pushed after open never re-runs it.
    const t = baseline();
    t.primaryFiles.push('scripts/check-diffdep.mjs');
    t.workflows['.github/workflows/pr-body-check.yml'] = [
      'name: PR Body Check',
      'on:',
      '  pull_request:',
      '    types: [opened, edited, reopened]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: node scripts/check-diffdep.mjs',
      '',
    ].join('\n');
    t.manifest.primaries.push({
      script: 'scripts/check-diffdep.mjs',
      disposition: 'gating',
      workflow: '.github/workflows/pr-body-check.yml',
      diffDependent: true,
      rationale: 'diff-dependent gate; host workflow lacks the synchronize trigger',
    });

    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(
      /scripts\/check-diffdep\.mjs\s+\[missing-synchronize-trigger\]/,
    );
  });

  it('EnforcerWiring_DiffDependentGateWithSynchronize_Passes (the class-4 fix)', () => {
    // The corrective: adding `synchronize` clears the class-4 violation. This is
    // exactly the pr-body-check.yml edit task 011 makes for check-golden-fixture-note.
    const t = baseline();
    t.primaryFiles.push('scripts/check-diffdep.mjs');
    t.workflows['.github/workflows/pr-body-check.yml'] = [
      'name: PR Body Check',
      'on:',
      '  pull_request:',
      '    types: [opened, edited, synchronize, reopened]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: node scripts/check-diffdep.mjs',
      '',
    ].join('\n');
    t.manifest.primaries.push({
      script: 'scripts/check-diffdep.mjs',
      disposition: 'gating',
      workflow: '.github/workflows/pr-body-check.yml',
      diffDependent: true,
      rationale: 'diff-dependent gate; host workflow now includes synchronize',
    });

    const result = audit(t);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('enforcer-wiring gate — completeness ratchet', () => {
  it('EnforcerWiring_PrimaryOnDiskWithoutManifestEntry_Fails', () => {
    // A newly-added enforcer that nobody dispositioned must not slip through.
    const t = baseline();
    t.primaryFiles.push('scripts/check-newcomer.mjs');
    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(
      /scripts\/check-newcomer\.mjs\s+\[unlisted-primary\]/,
    );
  });

  it('EnforcerWiring_RetiredEntryStillWired_Fails', () => {
    // Retiring a live enforcer is worse than missing a dead one: a retired
    // entry that is still reachable-and-failable from a workflow is a lie.
    const t = baseline();
    const [alpha] = t.manifest.primaries;
    if (!alpha) throw new Error('the baseline manifest must carry check-alpha');
    alpha.disposition = 'retired';
    alpha.rationale = 'claims retired but still wired in ci.yml';
    // check-alpha is still a failable ci.yml step + on disk.
    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(
      /scripts\/check-alpha\.mjs\s+\[retired-still-wired\]/,
    );
  });
});

describe('enforcer-wiring gate — exit-code analysis (the transitive core)', () => {
  it('AnalyzeCommandRefs_OrTrue_MarksLhsNonFailable', () => {
    // The real skills:guard line: lint:inv6 is caught by `|| true` (non-failable);
    // lint:test-first-drift is chained with `&&` (failable).
    const refs = analyzeCommandRefs(
      'node dist/skills-guard.js && (npm run lint:inv6 || true) && npm run lint:test-first-drift',
    );
    const inv6 = refs.find((r: { name?: string }) => r.name === 'lint:inv6');
    const drift = refs.find((r: { name?: string }) => r.name === 'lint:test-first-drift');
    expect(inv6?.failable).toBe(false);
    expect(drift?.failable).toBe(true);
  });

  it('AnalyzeCommandRefs_DirectOrTrue_OnScript_MarksNonFailable', () => {
    const refs = analyzeCommandRefs('node scripts/check-x.mjs || true');
    const x = refs.find((r: { path?: string }) => r.path === 'scripts/check-x.mjs');
    expect(x?.failable).toBe(false);
  });

  it('ReachPrimariesFromCommand_TransitivelyExpandsNpmChains', () => {
    const scripts = {
      guard: '(npm run inner || true)',
      inner: 'node scripts/check-deep.mjs',
    };
    const reached = reachPrimariesFromCommand('npm run guard', scripts);
    const deep = reached.get('scripts/check-deep.mjs');
    expect(deep, 'the deep primary must be reached at all').toBeDefined();
    expect(deep?.failable).toBe(false);
  });

  it('ParseWorkflow_ExtractsBareAndExplicitPullRequestTriggers', () => {
    const bare = parseWorkflow('on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: echo hi\n');
    expect(bare.pullRequest.present).toBe(true);
    expect(bare.pullRequest.types).toBeNull(); // bare → defaults include synchronize

    const explicit = parseWorkflow(
      'on:\n  pull_request:\n    types: [opened, synchronize]\njobs:\n  a:\n    steps:\n      - run: echo hi\n',
    );
    expect(explicit.pullRequest.types).toEqual(['opened', 'synchronize']);
  });
});
