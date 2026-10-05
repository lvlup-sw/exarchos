/**
 * Self-tests for the enforcer-wiring gate, `tools/audit/gates/check-enforcer-wiring.mjs`.
 * A name search proves only that a `check-*` gate exists.
 * A walk of the npm-script chains and the workflow run steps proves that a regression fails CI.
 * Each trap class has one synthetic fixture that the gate must reject.
 * A conforming synthetic tree and the real repository tree must pass.
 * NodeNext resolution needs the `.mjs` extension in the import, and `allowJs` infers the types.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  audit,
  analyzeCommandRefs,
  reachPrimariesFromCommand,
  parseWorkflow,
  enumeratePrimaryFiles,
  PRIMARY_DIR,
} from '../../tools/audit/gates/check-enforcer-wiring.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Builds a fixture path from the gate's own `PRIMARY_DIR`, not from a literal prefix.
 * A tree with a hard-coded prefix still passes after the primaries move, and then it tests nothing.
 */
const primary = (name: string): string => `${PRIMARY_DIR}/${name}`;

/** `<primary> [<violation-class>]`, with the path escaped for regex use. */
const violationOf = (name: string, klass: string): RegExp =>
  new RegExp(`${primary(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\[${klass}\\]`);

const CI_YML = [
  'name: CI',
  'on:',
  '  pull_request:',
  'jobs:',
  '  gate:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  `      - run: node ${primary('check-alpha.mjs')}`,
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

/**
 * A synthetic conforming tree, built fresh for each test.
 * `check-alpha.mjs` is gating: `ci.yml` runs it directly, and it can fail.
 * `lint-advisory.mjs` is advisory: a guard chain reaches it, but `|| true` hides its exit code, as for the real `lint-inv6`.
 * The return type is an annotation, not a cast. A cast widens `disposition` to `string` and hides a mismatch with `audit`.
 */
function baseline(): AuditInput {
  return {
    manifest: {
      primaries: [
        {
          script: primary('check-alpha.mjs'),
          disposition: 'gating',
          workflow: '.github/workflows/ci.yml',
          diffDependent: false,
          rationale: 'wired directly in the CI gate job',
        },
        {
          script: primary('lint-advisory.mjs'),
          disposition: 'advisory',
          workflow: '.github/workflows/ci.yml',
          rationale: 'neutered by design via `|| true` in the guard chain',
        },
      ],
    },
    scripts: {
      guard: 'node dist/x.js && (npm run lint:advisory || true) && npm run other',
      'lint:advisory': `node ${primary('lint-advisory.mjs')} content/`,
      other: 'echo ok',
    },
    workflows: {
      '.github/workflows/ci.yml': CI_YML,
    },
    primaryFiles: [primary('check-alpha.mjs'), primary('lint-advisory.mjs')],
  };
}

describe('enforcer-wiring gate — conforming trees pass', () => {
  it('EnforcerWiring_ConformingSyntheticTree_Passes', () => {
    const result = audit(baseline());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /** The test compares the violation list first, so a failure names the primary. */
  it('EnforcerWiring_ConformingTree_Passes (real repo)', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, ...PRIMARY_DIR.split('/'), 'enforcer-wiring-manifest.json'), 'utf8'),
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const wfDir = path.join(REPO_ROOT, '.github', 'workflows');
    const workflows: Record<string, string> = {};
    for (const name of fs.readdirSync(wfDir)) {
      if (!/\.ya?ml$/.test(name)) continue;
      workflows[`.github/workflows/${name}`] = fs.readFileSync(path.join(wfDir, name), 'utf8');
    }
    const primaryFiles = enumeratePrimaryFiles(path.join(REPO_ROOT, ...PRIMARY_DIR.split('/')));

    const result = audit({ manifest, scripts: pkg.scripts, workflows, primaryFiles });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * When the enumerator and the recognizer use different prefixes, each primary on disk reads as unlisted.
   * Each manifest entry then reads as missing. Only a test that uses both functions can find that defect.
   */
  it('EnforcerWiring_EnumeratorAndRecognizer_AgreeOnThePrimaryPrefix', () => {
    const onDisk = enumeratePrimaryFiles(path.join(REPO_ROOT, ...PRIMARY_DIR.split('/')));
    expect(onDisk.length).toBeGreaterThan(0);

    for (const rel of onDisk) {
      const reached = reachPrimariesFromCommand(`node ${rel}`, {});
      expect(reached.get(rel), `the recognizer must see the enumerated primary ${rel}`).toBeDefined();
    }
  });
});

describe('enforcer-wiring gate — trap-class fixtures (each MUST fail)', () => {
  /** A gating primary that no workflow and no npm chain references. */
  it('EnforcerWiring_OrphanScript_Fails', () => {
    const t = baseline();
    t.primaryFiles.push(primary('check-orphan.mjs'));
    t.manifest.primaries.push({
      script: primary('check-orphan.mjs'),
      disposition: 'gating',
      workflow: '.github/workflows/ci.yml',
      diffDependent: false,
      rationale: 'claims to gate but is wired nowhere',
    });

    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(violationOf('check-orphan.mjs', 'orphan'));
  });

  /** Only the npm script `validate` references the gating primary, and no workflow runs that script. */
  it('EnforcerWiring_ReachableOnlyViaUninvokedNpmScript_Fails', () => {
    const t = baseline();
    t.primaryFiles.push(primary('check-validateonly.mjs'));
    t.scripts.validate = `node ${primary('check-validateonly.mjs')}`;
    t.manifest.primaries.push({
      script: primary('check-validateonly.mjs'),
      disposition: 'gating',
      workflow: '.github/workflows/ci.yml',
      diffDependent: false,
      rationale: 'wired only into the uninvoked `npm run validate`',
    });

    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(
      violationOf('check-validateonly.mjs', 'unreachable-npm'),
    );
  });

  /**
   * CI runs the primary, but `|| true` in the npm chain hides its exit code, so it cannot fail.
   * The entry declares `gating`, so the gate must reject it. The test adds a CI step that runs the chain.
   */
  it('EnforcerWiring_ExitCodeSwallowedByOrTrue_Fails', () => {
    const t = baseline();
    t.primaryFiles.push(primary('check-neutered.mjs'));
    t.scripts['guard:neutered'] = '(npm run run-neutered || true)';
    t.scripts['run-neutered'] = `node ${primary('check-neutered.mjs')}`;
    const ciYml = t.workflows['.github/workflows/ci.yml'];
    if (ciYml === undefined) throw new Error('the baseline tree must carry ci.yml');
    t.workflows['.github/workflows/ci.yml'] = ciYml.replace(
      '      - run: npm run guard\n',
      '      - run: npm run guard\n      - run: npm run guard:neutered\n',
    );
    t.manifest.primaries.push({
      script: primary('check-neutered.mjs'),
      disposition: 'gating',
      workflow: '.github/workflows/ci.yml',
      diffDependent: false,
      rationale: 'claims to gate but its exit code is swallowed by `|| true`',
    });

    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(
      violationOf('check-neutered.mjs', 'exit-code-swallowed'),
    );
  });

  /**
   * The primary is wired and can fail, but the `pull_request` trigger of its workflow omits `synchronize`.
   * Thus a push after the PR opens does not run the gate again.
   */
  it('EnforcerWiring_DiffDependentGateWithoutSynchronize_Fails', () => {
    const t = baseline();
    t.primaryFiles.push(primary('check-diffdep.mjs'));
    t.workflows['.github/workflows/pr-body-check.yml'] = [
      'name: PR Body Check',
      'on:',
      '  pull_request:',
      '    types: [opened, edited, reopened]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - run: node ${primary('check-diffdep.mjs')}`,
      '',
    ].join('\n');
    t.manifest.primaries.push({
      script: primary('check-diffdep.mjs'),
      disposition: 'gating',
      workflow: '.github/workflows/pr-body-check.yml',
      diffDependent: true,
      rationale: 'diff-dependent gate; host workflow lacks the synchronize trigger',
    });

    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(
      violationOf('check-diffdep.mjs', 'missing-synchronize-trigger'),
    );
  });

  /** With `synchronize` in the trigger types, the same tree passes. */
  it('EnforcerWiring_DiffDependentGateWithSynchronize_Passes (the class-4 fix)', () => {
    const t = baseline();
    t.primaryFiles.push(primary('check-diffdep.mjs'));
    t.workflows['.github/workflows/pr-body-check.yml'] = [
      'name: PR Body Check',
      'on:',
      '  pull_request:',
      '    types: [opened, edited, synchronize, reopened]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - run: node ${primary('check-diffdep.mjs')}`,
      '',
    ].join('\n');
    t.manifest.primaries.push({
      script: primary('check-diffdep.mjs'),
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
    const t = baseline();
    t.primaryFiles.push(primary('check-newcomer.mjs'));
    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(
      violationOf('check-newcomer.mjs', 'unlisted-primary'),
    );
  });

  /** The `check-alpha` entry declares `retired`, but `ci.yml` still runs the file and the step can fail. */
  it('EnforcerWiring_RetiredEntryStillWired_Fails', () => {
    const t = baseline();
    const [alpha] = t.manifest.primaries;
    if (!alpha) throw new Error('the baseline manifest must carry check-alpha');
    alpha.disposition = 'retired';
    alpha.rationale = 'claims retired but still wired in ci.yml';
    const result = audit(t);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(
      violationOf('check-alpha.mjs', 'retired-still-wired'),
    );
  });
});

/**
 * `liveInputs` reads the live manifest, `package.json` and the workflows.
 * It parses JSON as `unknown` and checks the `primaries` array and the `scripts` object, so a renamed key fails there.
 * `grepGatesJobBlock` returns the text of the `grep-gates` job in `ci.yml`, up to the next job id.
 * The expected claims come from that text, not from a number that a person maintains.
 */
describe('enforcer-wiring gate — the unfiltered-CI-path claim has live subjects', () => {
  interface ManifestPrimary {
    readonly script: string;
    readonly workflow?: string;
    readonly unfilteredCiPath?: boolean;
    readonly ciStepMatch?: string;
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;

  function liveInputs(): AuditInput {
    const manifest = readJson(
      path.join(REPO_ROOT, ...PRIMARY_DIR.split('/'), 'enforcer-wiring-manifest.json'),
    );
    const pkg = readJson(path.join(REPO_ROOT, 'package.json'));

    const primaries = isRecord(manifest) ? manifest['primaries'] : undefined;
    if (!Array.isArray(primaries)) {
      throw new Error('enforcer-wiring-manifest.json has no `primaries` array');
    }
    const scripts = isRecord(pkg) ? pkg['scripts'] : undefined;
    if (!isRecord(scripts)) {
      throw new Error('package.json has no `scripts` object');
    }

    const wfDir = path.join(REPO_ROOT, '.github', 'workflows');
    const workflows: Record<string, string> = {};
    for (const name of fs.readdirSync(wfDir)) {
      if (!/\.ya?ml$/.test(name)) continue;
      workflows[`.github/workflows/${name}`] = fs.readFileSync(path.join(wfDir, name), 'utf8');
    }
    return {
      manifest: { primaries: primaries as ManifestEntry[] },
      scripts: scripts as Record<string, string>,
      workflows,
      primaryFiles: enumeratePrimaryFiles(path.join(REPO_ROOT, ...PRIMARY_DIR.split('/'))),
    };
  }

  function grepGatesJobBlock(): string {
    const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const lines = ci.split('\n');
    const start = lines.findIndex((l) => /^ {2}grep-gates:\s*$/.test(l));
    expect(start, 'grep-gates job not found in ci.yml').toBeGreaterThan(-1);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i] ?? '')) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join('\n');
  }

  function scriptsReferencedByGrepGates(): Set<string> {
    const block = grepGatesJobBlock();
    const found = new Set<string>();
    for (const match of block.matchAll(
      /\b(?:scripts|tools\/audit\/gates)\/[A-Za-z0-9._-]+\.(?:mjs|ts|sh|js)\b/g,
    )) {
      found.add(match[0]);
    }
    return found;
  }

  /**
   * The set of primaries that carry the `unfilteredCiPath` claim must equal the set that the `grep-gates` job hosts.
   * The expected set is derived, not a floor, because a floor permits the loss of some claims.
   * The job hosts a primary when it names the file, or when it holds the `ciStepMatch` text of an `npm run` step.
   * The last check audits the claims against the live tree.
   */
  it('UnfilteredCiPath_IsClaimedByTheGrepGatesPrimaries', () => {
    const { manifest } = liveInputs();
    const claiming = manifest.primaries.filter(
      (p: { unfilteredCiPath?: boolean }) => p.unfilteredCiPath === true,
    );
    const grepGatesBlock = grepGatesJobBlock();
    const grepGatesScripts = scriptsReferencedByGrepGates();
    expect(grepGatesScripts.size, 'no scripts parsed out of the grep-gates job').toBeGreaterThan(10);

    const expected = manifest.primaries
      .filter((p: { script: string; ciStepMatch?: string }) =>
        grepGatesScripts.has(p.script) ||
        (p.ciStepMatch !== undefined && grepGatesBlock.includes(p.ciStepMatch)),
      )
      .map((p: { script: string }) => p.script)
      .sort();
    expect(claiming.map((p: { script: string }) => p.script).sort()).toEqual(expected);

    for (const entry of claiming) {
      expect(entry.workflow, `${entry.script} claims a path without naming a workflow`).toBe(
        '.github/workflows/ci.yml',
      );
    }
    const result = audit(liveInputs());
    expect(result.violations, result.violations.join('\n')).toEqual([]);
  });

  /**
   * The probe adds an `if:` condition to the job that hosts a claiming primary, and the audit must reject the claim.
   * Without this check, a filter makes the gate skip, and read as passed, on the PRs that it guards.
   */
  it('UnfilteredCiPath_ClaimAgainstAFilteredLane_Fails', () => {
    const live = liveInputs();
    const claimed = live.manifest.primaries.find(
      (p: { unfilteredCiPath?: boolean }) => p.unfilteredCiPath === true,
    );
    expect(claimed, 'the probe needs a claiming primary').toBeDefined();

    const ci = live.workflows['.github/workflows/ci.yml'];
    expect(ci, 'ci.yml must be among the live workflows').toBeDefined();
    const filtered = ci!.replace(
      '  grep-gates:\n    name: Grep Gates (idempotency + substrate)\n    if: ',
      "  grep-gates:\n    name: Grep Gates (idempotency + substrate)\n    if: needs.changes.outputs.mcp == 'true' && ",
    );
    expect(filtered, 'the probe must actually change the workflow').not.toBe(ci);

    const result = audit({
      ...live,
      workflows: { ...live.workflows, '.github/workflows/ci.yml': filtered },
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(/\[filtered-ci-path\]/);
    expect(claimed!.script).toBeDefined();
    expect(result.violations.join('\n')).toContain(claimed!.script);
  });
});

describe('enforcer-wiring gate — exit-code analysis (the transitive core)', () => {
  /** `|| true` makes `lint:inv6` non-failable, and the `&&` chain keeps `lint:test-first-drift` failable. */
  it('AnalyzeCommandRefs_OrTrue_MarksLhsNonFailable', () => {
    const refs = analyzeCommandRefs(
      'node dist/skills-guard.js && (npm run lint:inv6 || true) && npm run lint:test-first-drift',
    );
    const inv6 = refs.find((r: { name?: string }) => r.name === 'lint:inv6');
    const drift = refs.find((r: { name?: string }) => r.name === 'lint:test-first-drift');
    expect(inv6?.failable).toBe(false);
    expect(drift?.failable).toBe(true);
  });

  it('AnalyzeCommandRefs_DirectOrTrue_OnScript_MarksNonFailable', () => {
    const refs = analyzeCommandRefs(`node ${primary('check-x.mjs')} || true`);
    const x = refs.find((r: { path?: string }) => r.path === primary('check-x.mjs'));
    expect(x?.failable).toBe(false);
  });

  it('ReachPrimariesFromCommand_TransitivelyExpandsNpmChains', () => {
    const scripts = {
      guard: '(npm run inner || true)',
      inner: `node ${primary('check-deep.mjs')}`,
    };
    const reached = reachPrimariesFromCommand('npm run guard', scripts);
    const deep = reached.get(primary('check-deep.mjs'));
    expect(deep, 'the deep primary must be reached at all').toBeDefined();
    expect(deep?.failable).toBe(false);
  });

  /** A bare `pull_request` trigger has `null` types, and the default types include `synchronize`. */
  it('ParseWorkflow_ExtractsBareAndExplicitPullRequestTriggers', () => {
    const bare = parseWorkflow('on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: echo hi\n');
    expect(bare.pullRequest.present).toBe(true);
    expect(bare.pullRequest.types).toBeNull();

    const explicit = parseWorkflow(
      'on:\n  pull_request:\n    types: [opened, synchronize]\njobs:\n  a:\n    steps:\n      - run: echo hi\n',
    );
    expect(explicit.pullRequest.types).toEqual(['opened', 'synchronize']);
  });
});
