import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { metadataPath } from './analyze.js';

const git = promisify(execFile);
const selected = /(?:^|\/)(?:\.node-version|\.bun-version|package\.json|package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|Directory\.Packages\.props|[^/]+\.csproj|(?:vite|vitest)\.config\.[^/]+)$/;

const fileLimit = 1_000_000;

/** A repository whose selected metadata exceeds the aggregate inspection budget. */
export class MetadataBudgetError extends Error {}

function chain(folder: string): string[] {
  const result = [folder];
  while (folder !== '.') {
    folder = posix.dirname(folder);
    result.push(folder);
  }
  return result;
}

/**
 * Read the tracked metadata files that inspection uses. A project path limits the read to that project and its parent folders.
 * A file over the per-file limit is returned with empty text, so its project reports an unresolved status.
 */
export async function collectMetadata(root: string, project?: string) {
  const cwd = await realpath(root);
  const top = await git('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (await realpath(top.stdout.trimEnd()) !== cwd) throw new Error('Select a Git repository root.');
  const { stdout } = await git('git', ['ls-files', '-z'], { cwd, maxBuffer: 8_000_000 });
  const scope = project === undefined ? undefined : chain(posix.dirname(project));
  const paths = stdout.split('\0').filter((path) => selected.test(path)
    && (scope === undefined || path === project || scope.includes(posix.dirname(path))));
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
      if (!stat.isFile()) continue;
      const oversized = stat.size > fileLimit;
      if (files.length === 512 || (!oversized && size + stat.size > 1_800_000)) {
        throw new MetadataBudgetError('Repository metadata exceeds the inspection budget. Select one project with --project.');
      }
      const buffer = Buffer.alloc(oversized || path.endsWith('bun.lockb') ? 0 : stat.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (bytesRead === 0) break;
        bytes += bytesRead;
      }
      if (bytes > stat.size) throw new Error('Repository metadata grew during inspection.');
      size += oversized ? 0 : path.endsWith('bun.lockb') ? stat.size : bytes;
      const text = buffer.toString('utf8', 0, bytes);
      files.push({ path, text });
    } finally {
      await handle.close();
    }
  }
  return files;
}
