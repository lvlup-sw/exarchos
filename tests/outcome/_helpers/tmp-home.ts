import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Run `fn` with `process.env.HOME` redirected to a fresh tmpdir. The tmpdir
 * (and any contents) are removed after `fn` resolves or throws, and the
 * prior `HOME` value is restored. Returns whatever `fn` returns.
 */
export async function withTmpHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-outcome-'));
  const priorHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    return await fn(tmp);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
