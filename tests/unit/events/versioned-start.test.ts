/** Versioned starts preserve historical extras and refuse generic phase authority.
 * @oracle-sources: ../../../src/events/event-validation.ts, literal phase expectations and transition model written in this test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { WorkflowEventBase, WorkflowStartedData, WorkflowStartedV11Data, EVENT_DATA_SCHEMAS } from '../../../src/events/schemas.js';
import { recordedInitialPhaseOf, validateEventData, validateEventRowData } from '../../../src/events/event-validation.js';
import { migrateEvents } from '../../../src/events/event-migration.js';
import { buildValidatedEvent } from '../../../src/events/event-factory.js';
import { workflowStateProjection } from '../../../src/projections/views/workflow-state-projection.js';
import { pipelineProjection } from '../../../src/projections/views/pipeline-view.js';
import { workflowStatusProjection } from '../../../src/projections/views/workflow-status-view.js';
import { rehydrationReducer } from '../../../src/projections/rehydration/reducer.js';
import { handleEventAppend, handleBatchAppend } from '../../../src/events/tools.js';
import { EventStore } from '../../../src/events/store.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum, InitInputSchema } from '../../../src/workflow/schemas.js';
import { registerWorkflowType, unregisterWorkflowType } from '../../../src/workflow/state-machine.js';
import { initStateFile, reconcileFromEvents } from '../../../src/workflow/state-store.js';
import { handleInit } from '../../../src/workflow/handlers/init.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const startData = { featureId: 'cold-user', workflowType: 'historical-user' };
function row(version: string | undefined, data: Record<string, unknown> | undefined) {
  const parsed = WorkflowEventBase.parse({ type: 'workflow.started', streamId: 'cold-user', sequence: 1,
    timestamp: '2026-01-01T00:00:00.000Z', data });
  return version === undefined ? { ...parsed, schemaVersion: undefined } : { ...parsed, schemaVersion: version };
}
function phases(event: ReturnType<typeof row>) {
  return [
    workflowStateProjection.apply(workflowStateProjection.init(), event).phase,
    rehydrationReducer.apply(rehydrationReducer.initial, event).workflowState.phase,
    pipelineProjection.apply(pipelineProjection.init(), event).phase,
    workflowStatusProjection.apply(workflowStatusProjection.init(), event).phase,
  ];
}
let dir: string;
let store: EventStore;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'versioned-start-')); store = new EventStore(dir); });
afterEach(async () => { unextendWorkflowTypeEnum('constructor'); unregisterWorkflowType('constructor'); await rmrfAsync(dir); });

describe('versioned start contract', () => {
  it('Decode_ColdUserType_AndLegacyConstructor_AcceptsWithoutRegistration', () => {
    const code = `import { WorkflowStartedData } from './src/events/schemas.ts';
      import { WorkflowStateSchema } from './src/workflow/schemas.ts';
      for (const name of ['historical-user','constructor']) {
        WorkflowStartedData.parse({featureId:'cold-user',workflowType:name});
        WorkflowStateSchema.parse({featureId:'cold-user',workflowType:name,phase:'entry',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',artifacts:{design:null,plan:null,pr:null},tasks:[],worktrees:{},reviews:{},synthesis:{integrationBranch:null,mergeOrder:[],mergedBranches:[],prUrl:null,prFeedback:[]}});
      }`;
    expect(() => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {cwd:process.cwd()})).not.toThrow();
    expect(InitInputSchema.safeParse(startData).success).toBe(false);
  });

  it('Start_LegacyUnknownPhaseAnyJson_Ignored', () => {
    fc.assert(fc.property(fc.jsonValue(), fc.constantFrom(undefined, '1.0', '1.2', 'other'), (extra, version) => {
      const event = row(version, {...startData, initialPhase: extra});
      expect(WorkflowStartedData.safeParse(event.data).success).toBe(true);
      expect(recordedInitialPhaseOf(event)).toBeUndefined();
      expect(phases(event)).toEqual(['plan', rehydrationReducer.initial.workflowState.phase, 'started', 'started']);
      const builtin = {...event, data:{...event.data, workflowType:'debug'}};
      expect(workflowStateProjection.apply(workflowStateProjection.init(), builtin).phase).toBe('triage');
    }));
  });

  it('Fold_RecordedUserEntry_PreservesPhase_ThroughTransitions', () => {
    fc.assert(fc.property(fc.constantFrom('entry', 'review', 'release'), fc.array(fc.constantFrom('entry','review','release')), (entry, transitions) => {
      const event = row('1.1', {...startData, initialPhase:entry});
      expect(phases(event)).toEqual([entry, entry, entry, entry]);
      let state = workflowStateProjection.apply(workflowStateProjection.init(), event);
      for (const to of transitions) state = workflowStateProjection.apply(state, {...event, type:'workflow.transition',data:{to}});
      expect(state.phase).toBe(transitions.at(-1) ?? entry);
      expect(buildValidatedEvent('cold-user', 1, event).schemaVersion).toBe('1.1');
    }));
  });

  it.each([undefined, {}, {...startData}, {...startData,initialPhase:''}, {...startData,initialPhase:7}, {...startData,initialPhase:null}, {...startData,initialPhase:{}}])('Start_ExactV11_MalformedDataRefuses %j', (data) => {
    const event = row('1.1', data);
    expect(() => validateEventRowData(event)).toThrow();
    expect(() => recordedInitialPhaseOf(event)).toThrow();
    expect(() => workflowStateProjection.apply(workflowStateProjection.init(), event)).toThrow();
    expect(() => rehydrationReducer.apply(rehydrationReducer.initial, event)).toThrow();
    expect(() => pipelineProjection.apply(pipelineProjection.init(), event)).toThrow();
    expect(() => workflowStatusProjection.apply(workflowStatusProjection.init(), event)).toThrow();
    expect(() => buildValidatedEvent('cold-user',1,event)).toThrow();
  });

  it('LegacyRegistry_ThirdArgument_AndAbsentData_AreUnchanged', () => {
    expect(EVENT_DATA_SCHEMAS['workflow.started']).toBe(WorkflowStartedData);
    expect(WorkflowStartedV11Data.safeParse({...startData, initialPhase:'entry'}).success).toBe(true);
    const registry = {'workflow.started':z.object({custom:z.literal(true)})};
    expect(() => validateEventData('workflow.started',undefined,registry)).not.toThrow();
    expect(() => validateEventRowData(row('other',undefined),registry)).not.toThrow();
    expect(() => validateEventRowData(row('1.0',{custom:true}),registry)).not.toThrow();
    expect(() => validateEventRowData(row('1.0',startData),registry)).toThrow();
  });

  it.each([{type:'workflow.started',schemaVersion:'1.1'}, {type:'workflow.started',data:{...startData,workflowType:'feature',initialPhase:undefined}}, {type:'workflow.started',data:startData}])('GenericStart_OwnPhaseOrRawV11_OrColdTypeRefuses %j', async (event) => {
    const single = await handleEventAppend({stream:'cold-user',event},dir,store);
    expect(single.error?.code).toBe('VALIDATION_ERROR');
    const batch = await handleBatchAppend({stream:'cold-user',events:[{type:'workflow.started',idempotencyKey:'same'},{type:'workflow.started',idempotencyKey:'same'}, event]},dir,store);
    expect(batch.error?.code).toBe('VALIDATION_ERROR');
    expect(batch.error?.message).toContain('events[2]');
    expect(await store.query('cold-user')).toEqual([]);
  });

  it('GenericStart_RegisteredConstructorAdmitted_AndAbsentDataUnknownKeysPreserved', async () => {
    extendWorkflowTypeEnum('constructor');
    for (const batch of [false,true]) {
      const stream = batch ? 'batch' : 'single';
      const event = {type:'workflow.started',schemaVersion:'other', data:{featureId:stream,workflowType:'constructor',unknown:{retained:true}}};
      const result = batch ? await handleBatchAppend({stream,events:[event]},dir,store) : await handleEventAppend({stream,event},dir,store);
      expect(result.success).toBe(true);
      const [stored] = await store.query(stream);
      expect(stored?.data?.unknown).toEqual({retained:true});
      expect(stored?.schemaVersion).not.toBe('other');
      const absent = batch ? await handleBatchAppend({stream,events:[{type:'workflow.started'}]},dir,store) : await handleEventAppend({stream,event:{type:'workflow.started'}},dir,store);
      expect(absent.success).toBe(true);
    }
  });

  it('ColdRecovery_RecordedEntry_AndCheckpointAgree', async () => {
    const event = buildValidatedEvent('cold-user',1,row('1.1',{...startData,initialPhase:'entry'}));
    await store.appendValidated('cold-user',event);
    expect((await reconcileFromEvents(dir,'cold-user',store)).reconciled).toBe(true);
    const state = JSON.parse(await readFile(path.join(dir,'cold-user.state.json'),'utf8'));
    expect(state.phase).toBe('entry');
    expect(state._checkpoint.phase).toBe('entry');
  });

  it.each([undefined, {}, {...startData}, {...startData,initialPhase:''}, {...startData,initialPhase:null}])('ColdRecovery_MalformedEpochRefusesBeforeMissingDataReturn %j', async (data) => {
    await store.appendValidated('cold-user',row('1.1',data));
    await expect(reconcileFromEvents(dir,'cold-user',store)).rejects.toThrow();
  });

  it.each([undefined,'1.0','1.2'])('Recovery_LegacyExtraUsesOriginalBuiltinEntry %s', async (version) => {
    const event = row(version,{...startData,workflowType:'debug',initialPhase:{ignored:true}});
    await store.appendValidated('cold-user',event);
    expect((await reconcileFromEvents(dir,'cold-user',store)).reconciled).toBe(true);
    expect(JSON.parse(await readFile(path.join(dir,'cold-user.state.json'),'utf8')).phase).toBe('triage');
  });

  it('Migration_OldStartsNeverUpcast_AndLegacyMissingDataKeepsFallback', () => {
    const rows = [row(undefined,{...startData,initialPhase:7}),row('1.0',{...startData,initialPhase:'entry'})];
    expect(migrateEvents(rows)).toEqual(rows);
    const missing = row('1.0',undefined);
    expect(phases(missing)).toEqual(['plan',rehydrationReducer.initial.workflowState.phase,'started','started']);
  });

  it('ExplicitEntry_RefusesConflictingDocumentOrCheckpoint', async () => {
    await expect(initStateFile(dir,'conflict-one','historical-user',{phase:'other'},'entry')).rejects.toThrow('must match');
    await expect(initStateFile(dir,'conflict-two','historical-user',{_checkpoint:{phase:'other'}},'entry')).rejects.toThrow('must match');
  });

  it('Init_UnregisteredCallerType_Refuses_AndRegisteredConstructorKeepsVersion10', async () => {
    expect((await handleInit(startData,dir,store)).success).toBe(false);
    extendWorkflowTypeEnum('constructor');
    registerWorkflowType('constructor',{initialPhase:'entry',phases:['entry','done'],transitions:[{from:'entry',to:'done',event:'finish'}]});
    expect((await handleInit({featureId:'constructor-run',workflowType:'constructor'},dir,store)).success).toBe(true);
    expect((await store.query('constructor-run'))[0]?.schemaVersion).toBe('1.0');
    const built = await initStateFile(dir,'explicit-user','historical-user',undefined,'entry');
    expect(built.state._checkpoint.phase).toBe(built.state.phase);
  });
});
