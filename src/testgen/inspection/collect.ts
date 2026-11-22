import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { metadataPath } from './analyze.js';

const git = promisify(execFile);
const selected = /(?:^|\/)(?:\.node-version|\.bun-version|package\.json|package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|Directory\.Packages\.props|[^/]+\.csproj|(?:vite|vitest)\.config\.[^/]+)$/;

export async function collectMetadata(root: string) {
  const cwd = await realpath(root);
  const top = await git('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (await realpath(top.stdout.trimEnd()) !== cwd) throw new Error('Select a Git repository root.');
  const { stdout } = await git('git', ['ls-files', '-z'], { cwd, maxBuffer: 8_000_000 });
  const paths = stdout.split('\0').filter((path) => selected.test(path));
  const files: { path: string; text: string }[] = [];
  let size = 0;
  for (const path of paths) {
    if (!metadataPath.safeParse(path).success) continue;
    const absolute = resolve(cwd, path);
    let actual: string;
    try { actual = await realpath(absolute); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    const inside = relative(cwd, actual);
    if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`) || actual !== absolute) continue;
    if (!(await lstat(actual)).isFile()) continue;
    const handle = await open(actual, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1_000_000 || size + stat.size > 1_800_000 || files.length === 512) {
        throw new Error('Repository metadata exceeds the inspection budget.');
      }
      const buffer = Buffer.alloc(path.endsWith('bun.lockb') ? 0 : stat.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (bytesRead === 0) break;
        bytes += bytesRead;
      }
      if (bytes > stat.size) throw new Error('Repository metadata grew during inspection.');
      size += path.endsWith('bun.lockb') ? stat.size : bytes;
      const text = buffer.toString('utf8', 0, bytes);
      files.push({ path, text });
    } finally {
      await handle.close();
    }
  }
  return files;
}
