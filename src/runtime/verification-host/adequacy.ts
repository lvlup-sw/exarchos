/** Source-revert measurement uses disposable source images at the registered checkout path. */
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { constants } from 'node:fs';
import {
  hostedAdequacyPassed, verificationValueDigest,
  type AdequacyRun, type HostedAdequacyFacts, type VerificationEvidence,
} from '../../contract/verification/harness-verification.js';
import type { AuthorizedVerification } from './authorization.js';
import { readAdequacyBlobs, readAdequacyGit, recheckVerification, runConfinedProfile } from './processes.js';

const maximumTreeEntries = 4096;
const maximumTreeBytes = 96 * 1024 * 1024;
const regularModes = new Set(['100644', '100755']);

/** Read immutable Git blob identities with no checkout, pathspec or export conversion. */
async function tree(authorized: AuthorizedVerification, commit: string) {
  const listing = await readAdequacyGit(authorized, ['ls-tree', '-r', '-z', commit]);
  const records = new TextDecoder('utf-8', { fatal: true }).decode(listing).split('\0');
  if (records.pop() !== '' || records.length > maximumTreeEntries) throw new Error('Tree exceeds hosted adequacy bounds');
  return new Map(records.map(record => {
    const match = /^([0-7]{6}) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\r\n]+)$/.exec(record);
    const mode = match?.[1];
    const oid = match?.[2];
    const path = match?.[3];
    if (mode === undefined || !regularModes.has(mode) || oid === undefined || path === undefined ||
      path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new Error('Unsupported entry in adequate source tree');
    }
    return [path, { mode, oid }];
  }));
}

type Tree = Awaited<ReturnType<typeof tree>>;
type TreeEntry = NonNullable<ReturnType<Tree['get']>>;

/** Keep Git metadata read-only and verify actual regular file bytes, mode, staged tree and untracked paths. */
async function checkOriginal(authorized: AuthorizedVerification, entries: Tree, blobs: ReadonlyMap<string, Buffer>) {
  await recheckVerification(authorized);
  const index = await readAdequacyGit(authorized, ['ls-files', '--stage', '-z']);
  const expected = [...entries].map(([path, { mode, oid }]) => `${mode} ${oid} 0\t${path}`).sort();
  const actual = new TextDecoder('utf-8', { fatal: true }).decode(index).split('\0');
  if (actual.pop() !== '' || verificationValueDigest(actual.sort()) !== verificationValueDigest(expected) ||
    (await readAdequacyGit(authorized, ['ls-files', '--others', '--exclude-standard', '-z'])).length !== 0) {
    throw new Error('Original checkout index or untracked files changed');
  }
  await checkTrackedFiles(authorized.resource.checkout, entries, blobs);
}

/** Check raw bytes and modes after a writable disposable test image has stopped. */
async function checkTrackedFiles(image: string, entries: Tree, blobs: ReadonlyMap<string, Buffer>) {
  for (const [path, entry] of entries) {
    const full = join(image, path);
    const file = await lstat(full);
    const bytes = blobs.get(entry.oid);
    if (bytes === undefined || !file.isFile() || await realpath(full) !== full || file.size !== bytes.length ||
      ((file.mode & 0o111) !== 0) !== (entry.mode === '100755') || !(await readFile(full)).equals(bytes)) {
      throw new Error('Source image differs from its exact committed tree');
    }
  }
}

/** Ask Node's test reporter for counts, stable identities and real assertion error codes. */
const nodeReporter = `export default async function* (events) {
  for await (const {type,data} of events) {
    if (type === 'test:summary') yield JSON.stringify({ counts: data.counts }) + '\\n';
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    if (data.details?.type === 'suite') continue;
    yield JSON.stringify({ caseId: [data.file, data.line, data.column, data.name, data.nesting],
      state: data.skip || data.todo ? 'ignored' : type === 'test:pass' ? 'passed' :
        data.details?.error?.cause?.code === 'ERR_ASSERTION' ? 'assertion' : 'infrastructure' }) + '\\n';
  }
}`;

const reporter = '--test-reporter=data:text/javascript,' + encodeURIComponent(nodeReporter);
const reportDestination = '/tmp/exarchos-adequacy-report';
const maximumReportBytes = 64 * 1024;

/** Report structured Vitest failures and actual case identities through the same bounded pipe. */
const vitestReporter = `import { writeFileSync } from 'node:fs';
export default class {
  onTestRunEnd(modules, unhandled, reason) {
    const cases = [];
    let invalid = unhandled.length > 0 || reason === 'interrupted';
    for (const mod of modules) {
      invalid ||= mod.errors().length > 0;
      for (const test of mod.children.allTests()) {
        const result = test.result();
        const state = result.state === 'passed' ? 'passed' :
          result.state === 'failed' && result.errors?.length > 0 &&
            result.errors.every(error => error.name === 'AssertionError') ? 'assertion' : 'infrastructure';
        cases.push({ caseId: [mod.moduleId, 0, 0, test.fullName, mod.project.name], state });
      }
    }
    const passed = cases.filter(test => test.state === 'passed').length;
    const failed = cases.filter(test => test.state === 'assertion').length;
    const report = [...cases, {
      counts: { tests: cases.length, passed, failed, cancelled: invalid ? 1 : 0, skipped: 0, todo: 0 }
    }].map(row => JSON.stringify(row)).join('\\n');
    if (Buffer.byteLength(report) > ${maximumReportBytes}) throw new Error('Adequacy report exceeds its bound');
    writeFileSync('${reportDestination}', report);
  }
}`;
type ProcessOutcome = Awaited<ReturnType<typeof runConfinedProfile>>;

/** Bound and normalize a structured report before assigning a test disposition. */
function measureAdequacyRun(
  result: ProcessOutcome, report: Buffer, checkout: string, selected: readonly string[],
): AdequacyRun {
  const outputDigest = verificationValueDigest({
    report: report.toString('base64'), stdout: result.stdoutBase64, stderr: result.stderrBase64,
  });
  const empty = { total: 0, passed: 0, failed: 0, outputDigest, casesDigest: verificationValueDigest([]) };
  if (result.reason === 'Execution deadline exceeded') return { ...empty, kind: 'timeout' };
  if (result.reason === 'Output limit exceeded') return { ...empty, kind: 'output-limit' };
  const ids = new Set<string>();
  const expectedFiles = new Set(selected.map(path => join(checkout, path)));
  const reportedFiles = new Set<string>();
  let passed = 0;
  let failed = 0;
  let counts: { tests: number; passed: number; failed: number } | undefined;
  try {
    for (const line of new TextDecoder('utf-8', { fatal: true }).decode(report).trim().split('\n')) {
      const item = JSON.parse(line);
      if (item.counts !== undefined) {
        if (counts !== undefined || !Number.isSafeInteger(item.counts.tests) ||
          item.counts.cancelled !== 0 || item.counts.skipped !== 0 || item.counts.todo !== 0) throw new Error('Invalid test counts');
        counts = item.counts;
        continue;
      }
      if (counts !== undefined || !Array.isArray(item.caseId) || item.caseId.length !== 5 ||
        !expectedFiles.has(item.caseId[0]) || typeof item.caseId[3] !== 'string' || !item.caseId[3] ||
        !['passed', 'assertion'].includes(item.state)) throw new Error('Unrecognized case');
      const identity = JSON.stringify(item.caseId);
      if (ids.has(identity)) throw new Error('Duplicate test case identity');
      ids.add(identity);
      reportedFiles.add(item.caseId[0]);
      if (item.state === 'passed') passed++;
      else failed++;
    }
  } catch { return { ...empty, kind: 'infrastructure' }; }
  if (counts === undefined || ids.size !== counts.tests || passed !== counts.passed || failed !== counts.failed) {
    return { ...empty, kind: 'infrastructure' };
  }
  const facts = { total: ids.size, passed, failed, outputDigest, casesDigest: verificationValueDigest([...ids].sort()) };
  if (ids.size === 0 && result.exitCode === 0) return { ...facts, kind: 'no-tests' };
  if (expectedFiles.size !== reportedFiles.size) return { ...empty, kind: 'infrastructure' };
  if (passed === ids.size && result.exitCode === 0) return { ...facts, kind: 'green' };
  if (failed > 0 && result.exitCode === 1) return { ...facts, kind: 'assertion-failure' };
  return { ...facts, kind: 'infrastructure' };
}

/** The signed oracle trusts approved test code. Its report is separate from ordinary process output. */
async function measureConfinedLeg(
  authorized: AuthorizedVerification, signal: AbortSignal, scratch: string, leg: string,
  image: string, args: string[], selected: readonly string[], reporterFile?: string,
): Promise<AdequacyRun> {
  const path = join(scratch, leg + '.report');
  const report = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDONLY, 0o600);
  try {
    const original = await report.stat();
    const result = await runConfinedProfile(authorized, signal, image, args, reporterFile, path);
    const final = await report.stat();
    const entry = await lstat(path);
    if (!final.isFile() || final.nlink !== 1 || original.dev !== entry.dev || original.ino !== entry.ino ||
      original.uid !== final.uid || (final.mode & 0o777) !== 0o600) throw new Error('Adequacy report identity changed');
    if (final.size > maximumReportBytes) {
      return measureAdequacyRun({ ...result, reason: 'Output limit exceeded' }, Buffer.alloc(0), authorized.resource.checkout, selected);
    }
    const bytes = Buffer.alloc(final.size);
    const { bytesRead } = await report.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== final.size) throw new Error('Adequacy report size changed');
    return measureAdequacyRun(result, bytes, authorized.resource.checkout, selected);
  } finally { await report.close(); }
}

async function putSource(image: string, path: string, entry: TreeEntry, bytes: Buffer) {
  const output = join(image, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o500 : 0o400 });
}

/** Run identical selected commands with the committed task source and its measured base source. */
export async function runHostedAdequacy(authorized: AuthorizedVerification, signal: AbortSignal): Promise<VerificationEvidence['outcome']> {
  const { request, resource, profile, policy } = authorized;
  if (request.operation !== 'adequacy' || profile.adequacy === undefined) throw new Error('Adequacy authorization required');
  const { tests, sources } = request.selection;
  const [before, after] = await Promise.all([tree(authorized, request.subject.baseCommit), tree(authorized, request.subject.headCommit)]);
  if (profile.adequacy.controlPaths.some(path => !after.has(path))) {
    throw new Error('A reviewed runner control file is missing from the exact task head');
  }
  const changed = new Set([...before.keys(), ...after.keys()].filter(path =>
    before.get(path)?.oid !== after.get(path)?.oid || before.get(path)?.mode !== after.get(path)?.mode));
  if (tests.some(path => !changed.has(path) || !after.has(path)) || sources.some(path => !changed.has(path))) {
    throw new Error('Selected paths do not match the original Git diff');
  }
  const needed = new Set([...after.values()].map(entry => entry.oid));
  for (const path of sources) {
    const base = before.get(path);
    if (base !== undefined) needed.add(base.oid);
  }
  const blobs = await readAdequacyBlobs(authorized, [...needed], maximumTreeBytes, signal);
  await checkOriginal(authorized, after, blobs);
  let baseline: AdequacyRun | null = null;
  let reverted: AdequacyRun | null = null;
  let disposition: HostedAdequacyFacts['disposition'] = tests.length === 0 ? 'no-tests' : sources.length === 0 ? 'no-sources' : 'infrastructure';
  if (tests.length > 0 && sources.length > 0) {
    const useVitest = profile.adequacy.reporter === 'vitest';
    const revertedEntries = new Map(after);
    for (const path of sources) {
      const base = before.get(path);
      if (base === undefined) revertedEntries.delete(path);
      else revertedEntries.set(path, base);
    }
    const scratch = await mkdtemp(join(policy.stateDir, 'adequacy-'));
    const baselineImage = join(scratch, 'baseline');
    const revertedImage = join(scratch, 'reverted');
    try {
      await mkdir(baselineImage);
      await mkdir(revertedImage);
      for (const [path, entry] of after) {
        const bytes = blobs.get(entry.oid);
        if (bytes === undefined) throw new Error('Missing captured head blob');
        await putSource(baselineImage, path, entry, bytes);
        if (!sources.includes(path)) {
          if (useVitest) await putSource(revertedImage, path, entry, bytes);
          else {
            const output = join(revertedImage, path);
            await mkdir(dirname(output), { recursive: true });
            await link(join(baselineImage, path), output);
          }
        }
      }
      for (const path of sources) {
        const entry = before.get(path);
        if (entry === undefined) continue;
        const bytes = blobs.get(entry.oid);
        if (bytes === undefined) throw new Error('Missing captured base blob');
        await putSource(revertedImage, path, entry, bytes);
      }
      const gitPointer = `gitdir: ${resource.gitDir}\n`;
      for (const image of [baselineImage, revertedImage]) {
        await writeFile(join(image, '.git'), gitPointer, { flag: 'wx', mode: 0o400 });
        if (profile.adequacy.dependencyRoot !== undefined) await mkdir(join(image, 'node_modules'));
      }
      const reporterFile = useVitest ? join(scratch, 'reporter.mjs') : undefined;
      if (reporterFile !== undefined) {
        await writeFile(reporterFile, vitestReporter, { mode: 0o400, flag: 'wx' });
        await writeFile(join(scratch, 'hosts'), '127.0.0.1 localhost\n::1 localhost\n', { mode: 0o400, flag: 'wx' });
      }
      const testArgs = useVitest ? tests : tests.map(path => './' + path);
      const argv = useVitest
        ? [profile.adequacy.npmEntry ?? '', 'run', 'test:files', '--', '--reporter=/tmp/exarchos-adequacy-reporter.mjs', ...testArgs]
        : ['--test', '--test-isolation=none', reporter, '--test-reporter-destination=' + reportDestination, '--', ...testArgs];
      await recheckVerification(authorized);
      baseline = await measureConfinedLeg(authorized, signal, scratch, 'baseline', baselineImage, argv, tests, reporterFile);
      if (useVitest) await checkTrackedFiles(baselineImage, after, blobs);
      if (baseline.kind === 'green') {
        await recheckVerification(authorized);
        reverted = await measureConfinedLeg(authorized, signal, scratch, 'reverted', revertedImage, argv, tests, reporterFile);
        if (useVitest) await checkTrackedFiles(revertedImage, revertedEntries, blobs);
      }
      disposition = baseline.kind === 'no-tests' ? 'no-tests' : 'measured';
    } finally {
      await rm(scratch, { force: true, recursive: true });
      try { await lstat(scratch); throw new Error('Disposable source image was not removed'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  }
  await checkOriginal(authorized, after, blobs);
  if (signal.aborted) throw new Error('Hosted adequacy was interrupted');
  const facts: HostedAdequacyFacts = { baseline, reverted, disposition, restored: true, cleanHead: request.subject.headCommit, childrenStopped: true };
  const passed = hostedAdequacyPassed(facts);
  return {
    adequacy: facts, status: passed ? 'passed' : 'failed', exitCode: null,
    reason: passed ? 'Recognized source-revert assertion failure' : 'Hosted adequacy did not prove a source-revert failure',
    stdoutBase64: '', stderrBase64: '',
  };
}
