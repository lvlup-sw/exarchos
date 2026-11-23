// @oracle-sources: the packaged exarchos binary on PATH, real Git merges on the integration branch, a suite log outside the checkout, and SQLite rows and claims read directly
/**
 * Prove through the packaged binary that a fresh typed prepare compiles exarchos-prepare-8-vcs with no compiler selector.
 * A harness lands the task branch on the integration branch. Then settle runs the integration suite in its local executor at that tip and accepts, with no verifier.
 * A settle in an integration checkout that does not hold the integration ref refuses before any claim, row or suite run.
 * The suite appends the tip that it sees to a log outside the checkout, so a case counts each suite run.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunBundleStore } from '../../src/events/bundle/run-bundle-store.js';
import { ContentDigestV1Schema } from '../../src/workflow/admission/types.js';
import { SettlementReceiptData } from '../../src/verbs/settle/schemas.js';
import { decodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { data, prepareRequest, settleArgs, STREAM, TASKS, withRaceRepository, type RaceRepository } from '../helpers/capsule/s6-process-race.js';
import { allClaims } from '../helpers/capsule/s7-process-race.js';

/** The time cap of one case: two packaged calls, one MCP server start and the Git steps of the fixture. */
const CASE_TIMEOUT_MS = 120_000;

/** The full integration ref that a fresh typed prepare pins from the bootstrap base. */
const INTEGRATION_REF = 'refs/heads/integration';

/** The command of the fixture. The integration mode appends the tip that it sees to the log that `FIXTURE_SUITE_LOG` names. */
const COMMAND = [
  "const fs=require('node:fs');const cp=require('node:child_process');",
  "if(process.argv[2]==='integration'){",
  "fs.appendFileSync(process.env.FIXTURE_SUITE_LOG,cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()+'\\n');}",
].join('');

/** The checkout config of the fixture. It resolves the static analysis, the probe and the integration suite to the fixture command. */
const CONFIG = JSON.stringify({ verification: { staticAnalysis: { lint: 'node command.cjs static' },
  tests: { globs: ['tests/**/*.test.js'], probe: { command: 'node command.cjs probe', files: 'as-arguments', failureExitCodes: [1] } },
  integration: { command: 'node command.cjs integration' } } });

/** One packaged workflow: the fixture, the environment that names the suite log, and the task worktree after a typed bootstrap. */
interface Activation {
  readonly f: RaceRepository;
  readonly env: Record<string, string>;
  readonly capsuleVersion: unknown;
  readonly args: string[];
  readonly suiteTips: () => Promise<string[]>;
}

/** Bootstrap the typed plan through the packaged CLI with no compiler selector, and commit the task in its own worktree. */
async function withActivation(work: (a: Activation) => Promise<void>): Promise<void> {
  await withRaceRepository(async f => {
    const log = path.join(f.controls, 'suite.log');
    const env = { FIXTURE_SUITE_LOG: log };
    const request = await prepareRequest(f, { workflowType: 'release-check' });
    const prepared = data((await f.cli(request.cli, env)).envelope);
    expect(prepared).toMatchObject({ capsuleVersion: 1, capsule: {
      provenance: { compilerVersion: 'exarchos-prepare-8-vcs' }, settlementContract: { integration: { ref: INTEGRATION_REF } } } });
    const id = TASKS[0];
    const worktreePath = await f.repository.worktreeFor(id, { [`src/${id}.js`]: 'export const value = 2;\n' });
    const args = settleArgs(prepared.capsuleVersion, [{ taskId: id, fields: { worktreePath, files: [`src/${id}.js`] }, evidence: [] }], 'activation');
    const suiteTips = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    await work({ f, env, capsuleVersion: prepared.capsuleVersion, args, suiteTips });
  }, { files: { 'command.cjs': COMMAND, '.exarchos.yml': CONFIG } });
}

describe('packaged compiler 8-vcs activation', () => {
  /**
   * A harness landing puts the task head on the integration tip. The packaged settle accepts and runs the suite once at that tip.
   * The settlement bundle names the tip and the digest of the stored local suite observation. An MCP replay returns the same receipt with no suite run.
   */
  it('TypedActivation_FreshPrepareHarnessLandingAndSettle_AcceptsAtTheTip', async () => {
    await withActivation(async ({ f, env, capsuleVersion, args, suiteTips }) => {
      const id = TASKS[0];
      await f.git(['merge', '-q', '--no-edit', `task/${id}`]);
      const tip = await f.git(['rev-parse', 'HEAD']);
      const settled = await f.cli(args, env);
      expect(settled.exitCode, JSON.stringify(settled.envelope)).toBe(0);
      const original = data(settled.envelope);
      expect(original).toMatchObject({ outcome: 'settled', acceptedTasks: [id], findings: [] });
      expect(await suiteTips()).toEqual([tip]);
      const receipt = SettlementReceiptData.parse(original);
      const ref = receipt.bundleRefs?.[0];
      if (ref === undefined) throw new Error('Missing settlement bundle reference');
      const bundle = decodeSettlementBundle(await RunBundleStore.forStateDir(f.stateDir).resolve(ContentDigestV1Schema.parse(ref.digest)));
      expect(bundle.integration).toMatchObject({ ref: INTEGRATION_REF, tip });
      expect(bundle.integration?.suiteEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
      const rows = f.ledger().rows;
      const claims = allClaims(f.database);
      const replay = await f.mcp('exarchos_orchestrate', { action: 'settle', featureId: STREAM, capsuleVersion, batchId: 'activation',
        claims: [{ taskId: id, fields: { worktreePath: await f.repository.worktreeFor(id), files: [`src/${id}.js`] }, evidence: [] }] }, env);
      expect(data(replay)).toEqual(original);
      expect(await suiteTips()).toEqual([tip]);
      expect(f.ledger().rows).toEqual(rows);
      expect(allClaims(f.database)).toEqual(claims);
    });
  }, CASE_TIMEOUT_MS);

  /** The integration checkout of the capsule scope holds another branch. The packaged settle refuses before any claim, row or suite run. */
  it('TypedActivation_WrongIntegrationCheckout_RefusesBeforeAnyClaim', async () => {
    await withActivation(async ({ f, env, args, suiteTips }) => {
      await f.git(['merge', '-q', '--no-edit', `task/${TASKS[0]}`]);
      await f.git(['switch', '-q', '-c', 'elsewhere']);
      const rows = f.ledger().rows;
      const claims = allClaims(f.database);
      const refused = await f.cli(args, env);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.envelope).toMatchObject({ success: false, error: { code: 'INTEGRATION_REFUSED',
        message: expect.stringContaining(`does not hold ${INTEGRATION_REF}`) } });
      expect(f.ledger().rows).toEqual(rows);
      expect(allClaims(f.database)).toEqual(claims);
      expect(await suiteTips()).toEqual([]);
    });
  }, CASE_TIMEOUT_MS);
});
