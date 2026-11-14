// @oracle-sources: ../../src/verbs/execute/executor.ts, real Git endpoint commits, probe-process source snapshots, persisted SQLite evidence and immutable input custody
/** Immutable leaf measurements retain the selected task delta and legacy calls retain their ref behavior. */
import fc from 'fast-check';
import { resolveConfig } from '../../src/config/resolve.js';
import { Database } from 'bun:sqlite';
import { getDispatchContext, runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { handleTaskComplete } from '../../src/verbs/tasks/tools.js';
import { TASK_COMPLETION } from '../../src/runbooks/definitions.js';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { TaskVerificationCoordinateSchema } from '../../src/contract/capsule/exarchos-capsule.js';
import { capsuleDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { configDigestAt } from '../../src/verbs/prepare/prepare-scope.js';
import { handleSettle } from '../../src/verbs/settle/handler.js';
import { productionExecuteDeps, derivedLeafOperationId } from '../../src/verbs/execute/executor.js';
import { decodeExecuteIntentBundle } from '../../src/verbs/execute/run-bundle.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { fixtureWiring } from '../unit/verbs/execute/fixtures.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { EventStore } from '../../src/events/store.js';
import { observeRepository } from '../../src/utils/git-tree.js';
import { nodeTestProfile } from '../helpers/verification-profile.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { runAsTrustedCaller, seedActivePhaseAttempt } from '../../tools/test-helpers/trusted-context.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

/** Executes fixture Git operations only in the isolated repository. */
async function git(tree: string, ...args: string[]) { return (await execFileAsync('git', ['-C', tree, ...args])).trim(); }

/** The real probe runner records source bytes on every baseline, revert and restored run. */
async function setup(dirtyProbe = false) {
  const stateDir = makeTempDir('s7-diff-');
  const journal = join(stateDir, 'probe.jsonl');
  const runner = `const fs=require('node:fs');const paths=process.argv.slice(2).filter(x=>x!=='--');const source=fs.readFileSync('src/value.cjs','utf8');const blocker=fs.existsSync('src/blocker.cjs')?fs.readFileSync('src/blocker.cjs','utf8'):null;fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({paths,source,blocker})+'\\n');let ok=true;for(const p of paths){const t=JSON.parse(fs.readFileSync(p,'utf8'));ok=ok&&source===t.source&&(t.blocker===undefined||blocker===t.blocker)}${dirtyProbe ? "fs.writeFileSync('PROBE_DIRTY','leftover');" : ""}process.exit(ok?0:1);`;
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'src/value.cjs': 'root', 'probe.cjs': runner } });
  closes.push(() => rmrfAsync(repo.root));
  const tree = await repo.worktreeFor('target');
  const events = new EventStore(stateDir); await events.initialize();
  closes.push(async () => { events.close(); await rmrfAsync(stateDir); });
  const identity = profiledValidCapsule().identity;
  await seedActivePhaseAttempt(events, identity.workflowId);
  const repository = await observeRepository(tree); if (repository.kind !== 'repository') throw new Error('Missing Git repository');
  const profile = nodeTestProfile();
  profile.tests.probe = { ...profile.tests.probe, command: { state: 'resolved', argv: [process.execPath, 'probe.cjs'], source: 'config' }, globs: ['**/*.test.json'], files: 'after-separator' };
  profile.tests.globs = { state: 'resolved', globs: ['**/*.test.json', '**/*.test.ts'], source: 'config' };
  const ctx: DispatchContext = { stateDir, eventStore: events, verificationProfile: { capsuleVersion: identity.capsuleVersion, profile } };
  const coordinate = async (base = repo.baseCommit, head?: string) => TaskVerificationCoordinateSchema.parse({ protocolVersion: '1', taskId: 'target', capsule: identity,
    repository: repository.repository, rootBaseCommit: repo.baseCommit, diffBaseCommit: base, observedHeadCommit: head ?? await git(tree, 'rev-parse', 'HEAD'), blockers: [] });
  const args = { featureId: identity.workflowId, taskId: 'target', repoRoot: tree, worktreePath: tree, baseBranch: 'main', branch: 'task/target', riskTier: 'medium', boundaryTouching: true };
  const call = (action: string, fields: Record<string, unknown>, context: DispatchContext = ctx) => runAsTrustedCaller(stateDir, () => {
    const handler = ACTION_HANDLERS[action]; if (handler === undefined) throw new Error('Missing real gate adapter');
    return handler({ ...args, ...fields }, stateDir, context);
  });
  const trusted = (selected: Awaited<ReturnType<typeof coordinate>>): DispatchContext => ({ ...ctx, verificationInput: { coordinate: selected, segmentOperationId: 'segment:fixture' } });
  const snapshots = async (): Promise<unknown[]> => (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { stateDir, journal, repo, tree, events, identity, ctx, coordinate, args, call, trusted, snapshots };
}

/** Publishes real approved custody and executes the canonical completion runbook. */
async function preparedRun(dirtyProbe = false) {
  const f = await setup(dirtyProbe);
  const commands = join(f.stateDir, 'commands.jsonl');
  const expected = join(f.stateDir, 'expected.json');
  const command = `const fs=require('node:fs'),cp=require('node:child_process');const expected=JSON.parse(fs.readFileSync(${JSON.stringify(expected)},'utf8'));const args=process.argv.slice(2);const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();fs.appendFileSync(${JSON.stringify(commands)},JSON.stringify(args)+'\\n');if(head!==expected.head)process.exit(6);if(args[0]==='diff'&&(args.length!==3||args[1]!==expected.base||args[2]!==expected.head))process.exit(7);if(args[0]==='dirty')fs.writeFileSync('DIRTY','changed');`;
  await f.repo.commitIn('target', { 'src/value.cjs': 'task', 'value.test.json': JSON.stringify({ source: 'task' }), 'commands.cjs': command });
  const selected = await f.coordinate();
  await writeFile(expected, JSON.stringify({base:f.repo.baseCommit,head:selected.observedHeadCommit}));
  const profile = f.ctx.verificationProfile!.profile;
  const cmd = (leg: string) => ({state:'resolved' as const, argv:[process.execPath,'commands.cjs',leg],source:'config' as const});
  profile.staticAnalysis={state:'resolved',checks:[{name:'lint',command:cmd('static')}],source:'config'};
  profile.integration.command=cmd('integration');
  profile.contract={codegen:cmd('codegen'),typecheck:cmd('typecheck'),diff:{...cmd('diff'),argv:[...cmd('diff').argv,'@baseCommit@','@headCommit@']}};
  const publish = async () => {
    const text = textOf([task('target', { riskTier: 'medium', boundaryTouching: true })]);
    const bundle = preparedFixture(text); const capsule = bundle.capsule;
    const read = readDesignRecord(Buffer.from(text), bundle.designRecord?.reference ?? 'plan.md');
    if (read.kind !== 'typed') throw new Error('Invalid approved fixture');
    capsule.provenance.compilerVersion = 'exarchos-prepare-8';
    capsule.graph.tasks = read.snapshot.tasks.map(entry => ({ taskId: entry.id, title: entry.title, stepId: 'delegate',
      stage: { kind: 'task-batch', stepId: 'delegate' }, taskContext: {
        taskId: entry.id, title: entry.title, instructions: entry.instructions, files: [...entry.files], testFiles: [...entry.testFiles],
        acceptance: [...entry.acceptance], riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
        blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
        source: { reference: read.snapshot.reference, digest: read.snapshot.digest, span: { ...entry.span } },
        knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] },
      } }));
    capsule.graph.dependencies = []; capsule.graph.joins = []; capsule.contracts.taskInputs = {};
    capsule.contracts.taskResults = { target: [{ name: 'worktreePath', type: 'string', required: true }] };
    capsule.settlementContract = { ...profiledValidCapsule().settlementContract, requiredResults: ['target'], skipPhases: [],
      verificationProfile: f.ctx.verificationProfile?.profile,
      verificationMode: 'immutable-task-diff-v1', scope: { repository: selected.repository, checkout: f.repo.checkout, configDigest: await configDigestAt(f.repo.checkout) },
      taskVerification: { target: { riskTier: 'medium', boundaryTouching: true, baseRef: 'main', baseCommit: f.repo.baseCommit } } };
    const digest = await f.events.bundleStore.put(encodePreparedBundle(bundle)); const initial = prepared(bundle);
    await f.events.append(capsule.identity.workflowId, { type: 'workflow.prepared', schemaVersion: '1.0', data: {
      ...initial.data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest }] } });

    return capsule;
  };
  const call = async (handlers = ACTION_HANDLERS, batchId = 'bound') => runAsTrustedCaller(f.stateDir, () => handleSettle({
    featureId:f.identity.workflowId,capsuleVersion:f.identity.capsuleVersion,batchId,
    claims:[{taskId:'target',fields:{worktreePath:f.tree},evidence:[]}]},f.stateDir,fixtureWiring(f.stateDir,f.events),
    {execute:productionExecuteDeps(handlers,'exarchos_orchestrate')}));
  return {...f, selected,profile,commands,publish,call};
}

describe('selected coordinate execution', () => {
  /** Real configured commands require the exact pair even after the moving base ref reaches the task head. */
  it('DriftTool_ConsumesExactCoordinate',async()=>{
    const f=await preparedRun();await f.publish();await git(f.tree,'update-ref','refs/heads/main',f.selected.observedHeadCommit);
    const result=await f.call();expect(result.success,JSON.stringify(result)).toBe(true);
    const rows=await f.events.query(f.identity.workflowId);
    expect(rows.filter(row=>row.type==='task.completed')).toHaveLength(1);
    const commands=(await readFile(f.commands,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(commands).toContainEqual(['diff',f.repo.baseCommit,f.selected.observedHeadCommit]);
    expect(commands).toContainEqual(['static']);expect(await f.snapshots()).toHaveLength(2);
    expect(await git(f.tree,'status','--porcelain')).toBe('');
  });

  /** Every missing or embedded token refuses before any configured command starts. */
  it('ResolvedUnboundCommand_Refuses',async()=>{
    const variants=[[],['@baseCommit@'],['@headCommit@'],['--base=@baseCommit@','@headCommit@'],['@baseCommit@','prefix@headCommit@']];
    await fc.assert(fc.asyncProperty(fc.boolean(),async(reverse)=>{
      for(const tokens of reverse?[...variants].reverse():variants){
        const f=await preparedRun();f.profile.contract.diff={state:'resolved',argv:[process.execPath,'commands.cjs','diff',...tokens],source:'config'};
        const result=await runAsTrustedCaller(f.stateDir,()=>ACTION_HANDLERS.check_contract_drift!({...f.args,coordinate:f.selected},f.stateDir,{...f.trusted(f.selected),projectConfig:resolveConfig({review:{gates:{'contract-drift':{D1:'warn'}}}})}));
        expect(result.error?.code).toBe('PROFILE_DIFF_COORDINATE_UNBOUND');expect(existsSync(f.commands)).toBe(false);
      }
    }),{numRuns:2,seed:8008});
  });

  /** A completed adequacy pair resumes without another provider run and keeps its original event references. */
  it('PassingAdequacy_OriginalClaims_ReplayWithoutProvider',async()=>{
    const f=await preparedRun();await f.publish();
    const interrupted={...ACTION_HANDLERS,check_contract_drift:async()=>{throw new Error('stop after committed adequacy pair')}};
    await f.call(interrupted).catch(()=>undefined);
    const before=await f.events.query(f.identity.workflowId);
    const pair=before.filter(row=>row.type==='admission.evidence-recorded'||row.type==='gate.executed');
    expect(pair).toHaveLength(2);expect(before.some(row=>row.type==='orchestrate.intent_executed')).toBe(false);
    expect(await f.snapshots()).toHaveLength(2);
    const resumed=await f.call();expect(resumed.success,JSON.stringify(resumed)).toBe(true);
    expect(await f.snapshots()).toHaveLength(2);
    const after=await f.events.query(f.identity.workflowId);
    for(const row of pair)expect(after.find(candidate=>candidate.sequence===row.sequence)).toEqual(row);
    const terminal=after.find(row=>row.type==='orchestrate.intent_executed');
    const refs=terminal?.data?.bundleRefs;if(!Array.isArray(refs)||refs[0]===undefined)throw new Error('Missing bundle');
    const run=decodeExecuteIntentBundle(await f.events.bundleStore.resolve(refs[0].digest));
    expect(run.leaves[0]?.disposition.kind).toBe('replay-elided');
    expect(run.leaves[0]?.events).toEqual(pair.map(row=>({type:row.type,streamId:row.streamId,sequence:row.sequence})));
  });
  /** Dirty provider output and a changed head after static analysis both prevent terminal completion. */
  it('HeadMovesBeforeCompletion_NoStanding',async()=>{
    for(const mode of ['dirty','head']){
      const f=await preparedRun();
      if(mode==='dirty')f.profile.staticAnalysis={state:'resolved',checks:[{name:'lint',command:{state:'resolved',argv:[process.execPath,'commands.cjs','dirty'],source:'config'}}],source:'config'};
      await f.publish();
      const handlers=mode==='dirty'?ACTION_HANDLERS:{...ACTION_HANDLERS,check_static_analysis:async(...args:Parameters<NonNullable<typeof ACTION_HANDLERS.check_static_analysis>>)=>{
        const result=await ACTION_HANDLERS.check_static_analysis!(...args);await git(f.tree,'commit','--allow-empty','-m','changed head');return result;
      }};
      await f.call(handlers);
      expect((await f.events.query(f.identity.workflowId)).filter(row=>row.type==='task.completed')).toEqual([]);
    }
  });

  /** A previous completion and matching-head static pass cannot replace this segment's own completion. */
  it('OldCompletion_DoesNotBypassNewSegment',async()=>{
    const f=await preparedRun();
    await runAsTrustedCaller(f.stateDir,async()=>{
      const first=await ACTION_HANDLERS.check_static_analysis!(f.args,f.stateDir,f.ctx);expect(first.success).toBe(true);
      const complete=await ACTION_HANDLERS.task_complete!({featureId:f.identity.workflowId,taskId:'target',result:{worktreePath:f.tree}},f.stateDir,f.ctx);expect(complete.success,JSON.stringify(complete)).toBe(true);
    });
    const before=(await f.events.query(f.identity.workflowId)).filter(row=>row.type==='task.completed');expect(before).toHaveLength(1);
    const borrowed=await runAsTrustedCaller(f.stateDir,()=>ACTION_HANDLERS.task_complete!({featureId:f.identity.workflowId,taskId:'target',coordinate:f.selected,result:{worktreePath:f.tree}},f.stateDir,f.trusted(f.selected)));
    expect(borrowed.success).toBe(false);
    await runAsTrustedCaller(f.stateDir,async()=>{
      const trusted=f.trusted(f.selected);
      const index=TASK_COMPLETION.steps.findIndex(step=>step.action==='check_static_analysis');
      const operationId=derivedLeafOperationId(trusted.verificationInput!.segmentOperationId,index,'check_static_analysis');
      await runWithDispatchContext({...getDispatchContext()!,operationId},()=>ACTION_HANDLERS.check_static_analysis!({...f.args,coordinate:f.selected},f.stateDir,trusted));
      const result=await ACTION_HANDLERS.task_complete!({featureId:f.identity.workflowId,taskId:'target',coordinate:f.selected,result:{worktreePath:f.tree}},f.stateDir,trusted);
      expect(result.success,JSON.stringify(result)).toBe(true);
    });
    const completed=(await f.events.query(f.identity.workflowId)).filter(row=>row.type==='task.completed');expect(completed).toHaveLength(2);
    expect(completed[0]).toEqual(before[0]);expect(completed[1]?.idempotencyKey).not.toBe(before[0]?.idempotencyKey);
  });

  /** Public coordinates, conflicting stream identity and a missing selected path confer no completion authority. */
  it('Completion_RequiresTrustedStreamAndNamedCheckout',async()=>{
    const f=await preparedRun();
    const common={featureId:f.identity.workflowId,taskId:'target',coordinate:f.selected,result:{worktreePath:f.tree}};
    const publicResult=await runAsTrustedCaller(f.stateDir,()=>ACTION_HANDLERS.task_complete!(common,f.stateDir,f.ctx));expect(publicResult.error?.code).toBe('TASK_COORDINATE_REFUSED');
    const wrong=await runAsTrustedCaller(f.stateDir,()=>ACTION_HANDLERS.task_complete!({...common,streamId:'other-stream'},f.stateDir,f.trusted(f.selected)));expect(wrong.error?.code).toBe('TASK_COORDINATE_REFUSED');
    await runAsTrustedCaller(f.stateDir,async()=>{
      await ACTION_HANDLERS.check_static_analysis!(f.args,f.stateDir,f.ctx);
      const staticOperationId=getDispatchContext()!.operationId;
      const result=await handleTaskComplete({featureId:f.identity.workflowId,taskId:'target'},f.stateDir,f.events,undefined,
        {coordinate:f.selected,segmentOperationId:'segment:no-path',staticOperationId});
      expect(result.success).toBe(false);expect(JSON.stringify(result)).toContain('tree-unnamed');
    });
    expect((await f.events.query(f.identity.workflowId)).filter(row=>row.type==='task.completed')).toEqual([]);
  });

  /** Incomplete, unclaimed, failing and wrong-head original-store pairs never rerun the completed provider. */
  it('AdequacyReplay_RejectsIncompleteAndMismatchedPairs',async()=>{
    for(const mode of ['missing-signal','missing-claim','orphan-claims','wrong-head','failed']){
      const f=await preparedRun();await f.publish();
      const interrupted={...ACTION_HANDLERS,check_contract_drift:async()=>{throw new Error('stop after committed adequacy pair')}};
      await f.call(interrupted).catch(()=>undefined);
      const rows=await f.events.query(f.identity.workflowId);const signal=rows.find(row=>row.type==='gate.executed');const evidence=rows.find(row=>row.type==='admission.evidence-recorded');
      expect(signal).toBeDefined();expect(evidence).toBeDefined();
      const db=new Database(join(f.stateDir,'exarchos.db'));
      try{
        if(mode==='orphan-claims')db.prepare('DELETE FROM events WHERE streamId=? AND operation_id=?').run(f.identity.workflowId,signal!.operationId!);
        if(mode==='missing-signal')db.prepare('DELETE FROM events WHERE streamId=? AND sequence=?').run(f.identity.workflowId,signal!.sequence);
        if(mode==='missing-claim')db.prepare('DELETE FROM idempotency_claims WHERE streamId=? AND idempotencyKey=?').run(f.identity.workflowId,evidence!.idempotencyKey!);
        if(mode==='wrong-head'||mode==='failed'){
          const data=structuredClone(signal!.data!);if(mode==='wrong-head')(data.details as Record<string,unknown>).head=f.repo.baseCommit;else data.passed=false;
          const stored=db.prepare('SELECT payload FROM events WHERE streamId=? AND sequence=?').get(f.identity.workflowId,signal!.sequence) as {payload:string};
          const payload=JSON.parse(stored.payload);payload.data=data;
          db.prepare('UPDATE events SET data=?,payload=? WHERE streamId=? AND sequence=?').run(JSON.stringify(data),JSON.stringify(payload),f.identity.workflowId,signal!.sequence);
        }
      }finally{db.close()}
      const before=await f.events.query(f.identity.workflowId);
      if(mode==='wrong-head')expect(before.find(row=>row.sequence===signal!.sequence)?.data?.details).toMatchObject({head:f.repo.baseCommit});
      if(mode==='failed')expect(before.find(row=>row.sequence===signal!.sequence)?.data?.passed).toBe(false);
      await f.call();
      const after=await f.events.query(f.identity.workflowId);
      expect(await f.snapshots()).toHaveLength(2);expect(after.filter(row=>row.type==='task.completed')).toEqual([]);
      expect(after.filter(row=>row.type==='gate.executed'||row.type==='admission.evidence-recorded')).toEqual(before.filter(row=>row.type==='gate.executed'||row.type==='admission.evidence-recorded'));
    }
  });

  /** Embedded text stays literal beside valid tokens, and unresolved or legacy commands retain their policy. */
  it('LiteralTokens_OptionalAndLegacyCommands',async()=>{
    const f=await preparedRun();
    const literal='prefix@baseCommit@';
    const script=`if(JSON.stringify(process.argv.slice(1))!==${JSON.stringify(JSON.stringify([f.repo.baseCommit,f.selected.observedHeadCommit,literal]))})process.exit(9)`;
    f.profile.contract={codegen:{state:'unresolved',reason:'optional codegen'},typecheck:{state:'unresolved',reason:'optional typecheck'},
      diff:{state:'resolved',argv:[process.execPath,'-e',script,'@baseCommit@','@headCommit@',literal],source:'config'}};
    const bound=await runAsTrustedCaller(f.stateDir,()=>ACTION_HANDLERS.check_contract_drift!({...f.args,coordinate:f.selected},f.stateDir,f.trusted(f.selected)));
    expect(bound.success).toBe(true);expect(bound.data).toMatchObject({passed:true});
    f.profile.contract.diff={state:'unresolved',reason:'optional diff'};
    const optional=await runAsTrustedCaller(f.stateDir,()=>ACTION_HANDLERS.check_contract_drift!({...f.args,coordinate:f.selected},f.stateDir,f.trusted(f.selected)));
    expect(optional.data).toMatchObject({passed:true,skipped:true,discriminant:'profile-unresolved'});
    const legacyScript=`if(process.argv[1]!=='@baseCommit@')process.exit(9)`;
    f.profile.contract.diff={state:'resolved',argv:[process.execPath,'-e',legacyScript,'@baseCommit@'],source:'config'};
    const legacy=await runAsTrustedCaller(f.stateDir,()=>ACTION_HANDLERS.check_contract_drift!(f.args,f.stateDir,f.ctx));
    expect(legacy.success).toBe(true);expect(legacy.data).toMatchObject({passed:true});
  });

  /** A real probe leaves untracked output after a valid kill, so repair cannot turn its unchecked result into replay authority. */
  it('DirtyAdequacy_CannotPublishPassingReplayPair',async()=>{
    const f=await preparedRun(true);
    const leftover=join(f.tree,'PROBE_DIRTY');
    await f.publish();
    const interrupted={...ACTION_HANDLERS,check_test_adequacy:async(...args:Parameters<NonNullable<typeof ACTION_HANDLERS.check_test_adequacy>>)=>{
      await ACTION_HANDLERS.check_test_adequacy!(...args);throw new Error('stop after genuine adequacy endpoint and pair');
    }};
    await f.call(interrupted).catch(()=>undefined);
    expect(existsSync(leftover)).toBe(true);
    expect((await f.snapshots()).map(row=>(row as {source:string}).source)).toEqual(['task','root']);
    const before=await f.events.query(f.identity.workflowId);
    const pair=before.filter(row=>row.type==='admission.evidence-recorded'||row.type==='gate.executed');
    expect(pair).toHaveLength(2);expect(before.some(row=>row.type==='orchestrate.intent_executed')).toBe(false);
    await unlink(leftover);expect(await git(f.tree,'status','--porcelain')).toBe('');
    await f.call();
    const after=await f.events.query(f.identity.workflowId);
    expect(await f.snapshots()).toHaveLength(2);
    expect(after.filter(row=>row.type==='task.completed')).toEqual([]);
    expect(after.filter(row=>row.type==='admission.evidence-recorded'||row.type==='gate.executed')).toEqual(pair);
    expect(pair.find(row=>row.type==='admission.evidence-recorded')?.data?.evidence).not.toMatchObject({verdict:'pass'});
    expect(pair.find(row=>row.type==='gate.executed')?.data?.passed).toBe(false);
  });

});
