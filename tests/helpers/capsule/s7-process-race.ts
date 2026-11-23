/** Packaged S7 fixtures own their store, Git wrapper, provider journal and stopped process group. */
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import { register, unregister } from '../process-tracker.js';
import { task, textOf } from './prepared-authority.js';
import { data, makeBarrier, prepareRequest, record, settleArgs, STREAM, withRaceRepository, type RaceRepository } from './s6-process-race.js';

/** Parses an observed string without replacing missing fixture evidence. */
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`Expected string: ${JSON.stringify(value)}`);
  return value;
}

/** Original immutable rows from all namespaces, including pre-leaf input bindings. */
export function allClaims(database: string) {
  const db = new Database(database, { readonly: true });
  try { return db.prepare('SELECT * FROM idempotency_claims ORDER BY streamId, idempotencyKey').all().map(record); }
  finally { db.close(); }
}

/** Reads workflow rows independently of the reserved binding payload format. */
export function rowsOf(database: string) {
  const db = new Database(database, { readonly: true });
  try {
    return db.prepare('SELECT payload FROM events WHERE streamId = ? ORDER BY sequence').all(STREAM).map(value => {
      const row = record(JSON.parse(string(record(value).payload)));
      return { ...row, type: string(row.type), sequence: Number(row.sequence), data: record(row.data ?? {}) };
    });
  } finally { db.close(); }
}

/** The provider logs its real arguments and source before running actual Node assertions. */
const COMMAND = `const fs=require('node:fs'),cp=require('node:child_process');
const [mode,...args]=process.argv.slice(2); const files=fs.readdirSync('src').filter(p=>p.endsWith('.cjs'));
fs.appendFileSync(process.env.S7_JOURNAL,JSON.stringify({mode,args,tree:process.cwd(),source:Object.fromEntries(files.map(p=>[p,fs.readFileSync('src/'+p,'utf8')]))})+'\\n');
const tests=mode==='probe'?args:mode==='integration'?fs.readdirSync('tests').map(p=>'tests/'+p):[];
for(const file of (tests.length?tests:files.map(p=>'src/'+p))){const result=cp.spawnSync(process.execPath,tests.length?[file]:['--check',file],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||2)}
`;

/** A true green/red source pair: unchanged assertions fail against the baseline implementation. */
function changedFiles(id: string) {
  return { [`src/${id}.cjs`]: 'module.exports = 1;\n',
    [`tests/${id}.test.cjs`]: `require('node:assert/strict').equal(require('../src/${id}.cjs'), 1);\n` };
}

/**
 * Bootstraps through the actual binary, which compiles a fresh typed plan with compiler 8-vcs.
 * Each task commits in its own worktree. Then the fixture lands each task branch on the integration branch, as a harness does.
 */
export async function withS7Repository(work: (f: S7Fixture) => Promise<void>, ids: readonly string[], risk: 'low' | 'high') {
  const tasks = ids.map(id => task(id, { files: [`src/${id}.cjs`], testFiles: [`tests/${id}.test.cjs`], riskTier: risk }));
  await withRaceRepository(async fixture => {
    const journal = path.join(fixture.controls, 'providers.jsonl');
    const env = { S7_JOURNAL: journal };
    const request = await prepareRequest(fixture, { workflowType: 'release-check' });
    const prepared = data((await fixture.cli(request.cli, env)).envelope);
    expect(record(prepared.capsule).provenance).toMatchObject({ compilerVersion: 'exarchos-prepare-8-vcs' });
    const trees = new Map<string, string>();
    for (const id of ids) trees.set(id, await fixture.repository.worktreeFor(id, changedFiles(id)));
    for (const id of ids) await fixture.git(['merge', '-q', '--no-edit', `task/${id}`]);
    const claims = ids.map(id => ({ taskId: id, fields: { worktreePath: trees.get(id), files: [`src/${id}.cjs`] }, evidence: [] }));
    const args = settleArgs(prepared.capsuleVersion, claims, 's7-process');
    await work({ ...fixture, journal, env, prepared, trees, args });
  }, { plan: textOf(tasks), files: { 'command.cjs': COMMAND,
    ...Object.fromEntries(ids.map(id => [`src/${id}.cjs`, 'module.exports = 0;\n'])),
    '.exarchos.yml': JSON.stringify({ verification: { tests: { globs: ['tests/**/*.test.cjs'],
      probe: { command: 'node command.cjs probe', files: 'as-arguments', failureExitCodes: [1] } },
      staticAnalysis: { lint: 'node command.cjs static' }, integration: { command: 'node command.cjs integration', report: 'exit-code' } }, typecheck: 'node command.cjs types' }),
  } });
}

export interface S7Fixture extends RaceRepository {
  readonly journal: string;
  readonly env: Record<string, string>;
  readonly prepared: Record<string, unknown>;
  readonly trees: ReadonlyMap<string, string>;
  readonly args: string[];
}

/** Read only observed invocations. Absence means no provider has started. */
export async function journalOf(f: S7Fixture) {
  try { return (await readFile(f.journal, 'utf8')).trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line))); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
}

/** Resolve Git before installing the wrapper, so the wrapper cannot call itself. */
async function gitOnPath() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(dir, 'git');
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error('Git missing from process fixture PATH');
}

/**
 * Holds the first constrained read of the barrier tree after a real pair or prior segment has committed.
 * The packaged binary finds the wrapper with its one PATH search. The constrained reader passes a closed environment with no PATH and no fixture value.
 * So the wrapper names the absolute Node executable and carries its barrier settings in its own text.
 */
export async function barrierFor(f: S7Fixture, taskId: string, mode: 'adequacy' | 'standing') {
  const realGit = await gitOnPath();
  const barrier = await makeBarrier(f.controls, `${mode}-barrier`);
  const bin = path.join(f.controls, 'bin'); await mkdir(bin);
  const wrapper = path.join(bin, 'git');
  const tree = f.trees.get(taskId); if (tree === undefined) throw new Error('Missing barrier tree');
  const settings = { realGit, tree, task: taskId, database: f.database, stream: STREAM, mode, barrier: barrier.directory };
  const driver = new URL('./s7-race-driver.mjs', import.meta.url).href;
  await writeFile(wrapper, `#!${process.execPath}\nimport(${JSON.stringify(driver)}).then(module => module.drive(${JSON.stringify(settings)}));\n`);
  await chmod(wrapper, 0o755);
  return { ...barrier, env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } };
}

/** Starts one detached group so an interrupt stops every owned gate and Git child before retry. */
export function startSettle(f: S7Fixture, env: Record<string, string>) {
  const child = spawn('exarchos', [...f.args, '--json'], { cwd: f.repository.checkout, detached: true,
    env: { ...process.env, WORKFLOW_STATE_DIR: f.stateDir, EXARCHOS_STATE_DIR: f.stateDir, EXARCHOS_TELEMETRY: 'false', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  register(child);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const done = new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => { unregister(child); resolve({ stdout, stderr, code }); });
  });
  const signal = (name: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, name); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  };
  return { done, async stop() {
    signal('SIGTERM'); await Promise.race([done, delay(1000)]); signal('SIGKILL'); await done;
  } };
}
