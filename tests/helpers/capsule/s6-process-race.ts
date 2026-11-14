/** Real checkout, SQLite observations and bounded barriers for packaged workflow tests. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { expect } from 'vitest';

import { STORE_DB_FILENAME } from '../../../src/utils/paths.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { task, textOf } from './prepared-authority.js';
import { runCli } from '../cli-runner.js';
import { releaseCheckDefinition } from '../definitions/user-definition.js';
import { withHermeticEnv } from '../hermetic.js';
import { spawnMcpClient } from '../mcp-client.js';
import { extractEnvelope } from '../mcp-envelope.js';
import { scopedRepository } from '../scoped-repository.js';

export const STREAM = 's6-process-race';
export const PLAN = 'design.md';
const DEFINITION = '.exarchos/workflows/release-check.json';
export const BASE = 'integration';
export const TASKS = ['T-01', 'T-02'] as const;
export const DRIVER = fileURLToPath(new URL('./s6-race-driver.mjs', import.meta.url));

type RecordValue = Record<string, unknown>;

export function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return value as RecordValue;
}

export function data(envelope: RecordValue): RecordValue {
  expect(envelope.success, JSON.stringify(envelope)).toBe(true);
  return record(envelope.data);
}

export function typedTasks(ids: readonly string[], high: readonly string[] = []) {
  return ids.map(id => task(id, {
    files: [`src/${id}.js`], testFiles: [`tests/${id}.test.js`],
    riskTier: high.includes(id) ? 'high' : 'low',
  }));
}

export function directDefinition() {
  return { ...releaseCheckDefinition(), entryStepId: 'build' };
}

export function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function makeBarrier(root: string, name: string) {
  const directory = path.join(root, name);
  await mkdir(directory);
  return {
    directory,
    async wait(): Promise<RecordValue> {
      const deadline = performance.now() + 10_000;
      const ready = path.join(directory, 'ready.json');
      while (performance.now() < deadline) {
        try {
          return record(JSON.parse(await readFile(ready, 'utf8')));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await setTimeout(15);
      }
      throw new Error(`No readiness record for ${name}`);
    },
    async release() {
      const release = path.join(directory, 'release');
      const temporary = `${release}.tmp`;
      await writeFile(temporary, '');
      await rename(temporary, release);
    },
  };
}

export type Barrier = Awaited<ReturnType<typeof makeBarrier>>;

async function gitOnPath(): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const full = path.resolve(directory, 'git');
    try {
      await access(full, constants.X_OK);
      return full;
    } catch (error) {
      if (!['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('Git is not on PATH');
}

export async function gitBarrier(root: string, checkout: string) {
  const realGit = await gitOnPath();
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!/usr/bin/env node\nprocess.argv.splice(2, 0, 'git');\nimport(${JSON.stringify(new URL('./s6-race-driver.mjs', import.meta.url).href)});\n`);
  await chmod(wrapper, 0o755);
  return (barrier: Barrier) => ({
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    S6_REAL_GIT: realGit, S6_CHECKOUT: checkout, S6_BARRIER: barrier.directory,
  });
}

export interface LedgerRow {
  readonly type: string;
  readonly sequence: number;
  readonly schemaVersion?: string;
  readonly data?: RecordValue;
}

export interface Operation {
  readonly key: string;
  readonly result: RecordValue;
  readonly sequences: readonly number[];
}

export function readLedger(database: string, stream: string) {
  const db = new Database(database, { readonly: true });
  try {
    const stored = db.prepare('SELECT payload FROM events WHERE streamId = ? ORDER BY sequence').all(stream) as { payload: string }[];
    const rows = stored.map(({ payload }) => JSON.parse(payload) as LedgerRow);
    const claims = db.prepare(
      "SELECT idempotencyKey, events_json, sequences FROM idempotency_claims WHERE streamId = '__decide_once_operations__' AND json_extract(events_json, '$.streamId') = ? ORDER BY idempotencyKey",
    ).all(stream) as { idempotencyKey: string; events_json: string; sequences: string }[];
    const operations: Operation[] = claims.map(row => ({
      key: row.idempotencyKey, result: record(record(JSON.parse(row.events_json)).result),
      sequences: JSON.parse(row.sequences) as number[],
    }));
    const state = db.prepare('SELECT state FROM workflow_state WHERE featureId = ?').get(stream) as { state: string } | undefined;
    return { rows, operations, document: state === undefined ? undefined : record(JSON.parse(state.state)) };
  } finally {
    db.close();
  }
}

export function changeDatabase(database: string, sql: string, ...args: string[]): void {
  const db = new Database(database);
  try {
    db.prepare(sql).run(...args);
  } finally {
    db.close();
  }
}

export async function withRaceRepository<T>(
  work: (fixture: RaceRepository) => Promise<T>,
  options: { readonly plan?: string; readonly files?: Readonly<Record<string, string>> } = {},
): Promise<T> {
  return withHermeticEnv(async env => {
    const repository = await scopedRepository({
      integrationBranch: BASE,
      files: {
        [PLAN]: options.plan ?? textOf(typedTasks([TASKS[0]])),
        [DEFINITION]: JSON.stringify(directDefinition()),
        'package.json': JSON.stringify({
          type: 'module', scripts: { lint: 'node -e ""', typecheck: 'node -e ""', 'test:files': 'node --test', 'test:run': 'node --test' },
        }),
        ...options.files,
      },
    });
    const controls = path.join(repository.root, 'controls');
    const database = path.join(env.stateDir, STORE_DB_FILENAME);
    const vars = { WORKFLOW_STATE_DIR: env.stateDir, EXARCHOS_STATE_DIR: env.stateDir, EXARCHOS_TELEMETRY: 'false' };
    const cli = async (args: string[], extra: Record<string, string> = {}, cwd = env.cwdDir) => {
      const result = await runCli({ args: [...args, '--json'], cwd, env: { ...vars, ...extra }, timeout: 35_000 });
      try {
        return { ...result, envelope: record(JSON.parse(result.stdout)) };
      } catch (error) {
        throw new Error(`CLI exit ${result.exitCode}: ${result.stderr}\n${result.stdout}`, { cause: error });
      }
    };
    const mcp = async (tool: string, args: RecordValue, extra: Record<string, string> = {}) => {
      const client = await spawnMcpClient({ stateDir: env.stateDir, env: { ...vars, PATH: process.env.PATH ?? '', ...extra } });
      try {
        return record(extractEnvelope(await client.client.callTool({ name: tool, arguments: args }, { timeout: 35_000 })));
      } finally {
        await client.terminate();
      }
    };
    try {
      await mkdir(controls);
      return await work({
        repository, controls, database, stateDir: env.stateDir, cli, mcp,
        ledger: (stream = STREAM) => readLedger(database, stream),
        writePlan: text => writeFile(path.join(repository.checkout, PLAN), text),
        git: async args => (await execFileAsync('git', args, { cwd: repository.checkout, timeout: 12_000 })).trim(),
      });
    } finally {
      await rmrfAsync(repository.root);
    }
  });
}

export interface RaceRepository {
  readonly repository: Awaited<ReturnType<typeof scopedRepository>>;
  readonly controls: string;
  readonly database: string;
  readonly stateDir: string;
  readonly cli: (args: string[], env?: Record<string, string>, cwd?: string) => Promise<Awaited<ReturnType<typeof runCli>> & { envelope: RecordValue }>;
  readonly mcp: (tool: string, args: RecordValue, env?: Record<string, string>) => Promise<RecordValue>;
  readonly ledger: (stream?: string) => ReturnType<typeof readLedger>;
  readonly writePlan: (text: string) => Promise<void>;
  readonly git: (args: string[]) => Promise<string>;
}

export async function prepareRequest(
  fixture: RaceRepository, options: { mode?: 'bootstrap' | 'compile'; workflowType?: string; stream?: string } = {},
) {
  const { mode = 'bootstrap', workflowType = 'feature', stream = STREAM } = options;
  const repoRoot = fixture.repository.checkout;
  const bytes = await readFile(path.join(repoRoot, PLAN));
  const intent = { mode, workflowType, baseRef: BASE, designRef: PLAN, approval: { decision: 'approved', designDigest: digest(bytes) } };
  return { bytes, intent, mcp: { action: 'prepare', featureId: stream, repoRoot, intent },
    cli: ['orchestrate', 'prepare', '--feature-id', stream, '--repo-root', repoRoot, '--intent', JSON.stringify(intent)] };
}

export function prepareRows(rows: readonly LedgerRow[]) {
  return rows.filter(row => row.type === 'workflow.prepared');
}

export function settleArgs(capsuleVersion: unknown, claims: readonly RecordValue[], batchId = 'race') {
  return ['orchestrate', 'settle', '--feature-id', STREAM, '--capsule-version', String(capsuleVersion), '--batch-id', batchId, '--claims', JSON.stringify(claims)];
}
