/**
 * spec_coverage_check with a probe command that does not resolve and a declared test outside the probe globs.
 * The check reads the state of the probe command before the runner-fit check, as the kill probe does.
 * So it fails with `profile-unresolved` and the reason of the probe term, not with the runner-fit reason.
 *
 * Each case calls the handler at a real temporary root. `node:child_process` is a stub, so no process starts.
 * The evidence runner is a stub that calls only the provider.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: (request: { readonly executeProvider: () => Promise<ToolResult> }) => request.executeProvider(),
}));

import { execFileSync } from 'node:child_process';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { handleSpecCoverageCheck, type SpecCoverageCheckArgs } from '../../../../src/verbs/gates/spec-coverage-check.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { pinnedTestProfile } from '../../../helpers/verification-profile.js';

/** The fields of the result that the cases read. The parse checks them, so no case trusts the shape of the data. */
const CoverageDataSchema = z.object({
  passed: z.boolean(),
  report: z.string(),
  discriminant: z.string().optional(),
  reason: z.string().optional(),
});

type CoverageData = z.infer<typeof CoverageDataSchema>;

/** The words of the runner-fit reason. A check that reads the probe globs first gives them. */
const RUNNER_FIT_WORDS = 'the probe command cannot run the declared test files';

/** The reason of the unresolved probe command of the pinned case. */
const PINNED_PROBE_REASON = 'tests.probe.command: no test command resolves. Set verification.tests.probe.command.';

let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
  root = mkdtempSync(join(tmpdir(), 'spec-coverage-unfit-unresolved-'));
});

afterEach(() => {
  rmrf(root);
});

/** Writes each file under the root, and makes its directory first. */
function writeFiles(files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

/** Writes a plan that declares `src/a.test.ts` and calls the handler after implementation. A case gives its pin in `extra`. */
async function check(extra: Partial<SpecCoverageCheckArgs> = {}): Promise<CoverageData> {
  const planFile = join(root, 'plan.md');
  writeFileSync(planFile, ['**Files:**', '- `src/a.test.ts`'].join('\n'));
  const result = await handleSpecCoverageCheck(
    { featureId: 'feat-spec-coverage-unfit', planFile, repoRoot: root, coveragePhase: 'post-implementation', ...extra },
    root,
    new EventStore(root),
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  return CoverageDataSchema.parse(result.data);
}

describe('an unresolved probe command beside a declared test that its globs do not hold', () => {
  /**
   * The live arm is a Node root beside a solution with a configured `dotnet test` probe and no `verification.tests.globs`.
   * The probe term is unresolved, and its globs are the dotnet globs, which do not hold `src/a.test.ts`.
   * The pinned arm pins such a term. The killing assertion: the result carries `profile-unresolved` and a reason.
   * The old check reads the globs first, so it fails with the runner-fit reason and no discriminant.
   */
  it('SpecCoverage_AnUnresolvedProbeWithAnUnfitDeclaredTest_FailsWithProfileUnresolved', async () => {
    writeFiles({
      'package.json': JSON.stringify({ scripts: { 'test:files': 'vitest run' } }),
      'App.sln': '',
      '.exarchos.yml': ['verification:', '  tests:', '    probe:', '      command: dotnet test App.sln', ''].join('\n'),
      'src/a.test.ts': '',
    });
    const pin = pinnedTestProfile(5, {
      probe: {
        command: { state: 'unresolved', reason: PINNED_PROBE_REASON },
        files: 'none',
        failureExitCodes: { codes: [1], source: 'detection' },
        globs: ['**/*Tests.cs'],
      },
    });

    const live = await check();
    const pinned = await check({ verificationProfile: pin });

    for (const data of [live, pinned]) {
      expect(data.passed).toBe(false);
      expect(data.discriminant).toBe('profile-unresolved');
      expect(data.reason).toContain('tests.probe.command');
      expect(data.report).toContain('profile-unresolved');
      expect(data.report).not.toContain(RUNNER_FIT_WORDS);
    }
    expect(live.reason).toContain('verification.tests.globs');
    expect(live.reason).toContain('Then run the gate again.');
    expect(pinned.reason).toContain(PINNED_PROBE_REASON);
    expect(pinned.reason).toContain('Capsule v5 pins this term');
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });
});
