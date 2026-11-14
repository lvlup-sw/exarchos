/** Runs a fixture barrier after a real Git observation or inside a real test command. */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { access, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function pause(directory, facts) {
  const ready = path.join(directory, 'ready.json');
  const temp = `${ready}.${process.pid}`;
  await writeFile(temp, JSON.stringify(facts));
  await rename(temp, ready);
  const release = path.join(directory, 'release');
  const end = performance.now() + 15_000;
  while (performance.now() < end) {
    try {
      await access(release);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await setTimeout(10);
  }
  throw new Error(`fixture barrier timed out: ${directory}`);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'git') {
  const result = spawnSync(process.env.S6_REAL_GIT, args, { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  const expected = ['-C', process.env.S6_CHECKOUT, 'rev-parse', '--verify', '--quiet', '--end-of-options', 'integration^{commit}'];
  if (args.length === expected.length && args.every((arg, index) => arg === expected[index])) {
    await pause(process.env.S6_BARRIER, { status: result.status, commit: result.stdout.trim() });
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else if (mode === 'suite') {
  if (path.basename(process.cwd()) === 'worktree-T-02' && process.env.S6_BARRIER) {
    await pause(process.env.S6_BARRIER, { tree: process.cwd(), gate: 'integration-suite' });
  }
} else if (mode === 'fifo') {
  const [fifo, directory, bytes] = args;
  const deadline = performance.now() + 12_000;
  let fd;
  while (fd === undefined && performance.now() < deadline) {
    try {
      fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code !== 'ENXIO') throw error;
      await setTimeout(10);
    }
  }
  if (fd === undefined) throw new Error('The packaged reader did not open the fixture FIFO');
  try {
    await pause(directory, { fifo });
    const payload = Buffer.from(bytes, 'base64');
    const end = performance.now() + 5000;
    let offset = 0;
    while (offset < payload.length) {
      try {
        offset += writeSync(fd, payload, offset, payload.length - offset);
      } catch (error) {
        if (error.code !== 'EAGAIN' || performance.now() >= end) throw error;
        await setTimeout(10);
      }
    }
  } finally {
    closeSync(fd);
  }
} else {
  throw new Error(`unknown fixture mode: ${mode}`);
}
