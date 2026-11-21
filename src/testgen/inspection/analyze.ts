import { posix } from 'node:path';
import { z } from 'zod';
import { supportsFramework } from '../contract/targets.js';

export const metadataPath = z.string().max(300).regex(/^(?:[\w.-]+\/)*[\w.-]+$/)
  .refine((path) => path.split('/').every((part) => part !== '.' && part !== '..'));

export const inspectInput = z.strictObject({
  files: z.array(z.strictObject({ path: metadataPath, text: z.string().max(1_000_000) })).max(512),
  project: metadataPath.optional(),
});

const projectSchema = z.strictObject({
  path: metadataPath,
  cwd: z.string(),
  runner: z.string().nullable(),
  version: z.string().nullable(),
  status: z.enum(['supported', 'requires-qualification', 'unsupported', 'ambiguous', 'no-suite']),
  sources: z.array(metadataPath),
  commands: z.array(z.string()),
  tools: z.array(z.string()),
  environments: z.array(z.string()),
  testIncludes: z.array(z.string()),
  unresolved: z.array(z.string()),
});

export const inspectSuccess = z.strictObject({ ok: z.literal(true), projects: z.array(projectSchema) });
type Project = z.infer<typeof projectSchema>;
type Snapshot = z.infer<typeof inspectInput>;

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); }
  catch { return undefined; }
}

const stringMap = z.record(z.string(), z.string());
const manifestSchema = z.object({
  scripts: stringMap.optional(),
  dependencies: stringMap.optional(),
  devDependencies: stringMap.optional(),
});
const npmLock = z.object({ packages: z.record(z.string(), z.object({ version: z.string().optional() })) });
const exactVersion = /^\d+\.\d+\.\d+$/;

function ancestors(cwd: string): string[] {
  const result = [cwd];
  while (cwd !== '.') {
    cwd = posix.dirname(cwd);
    result.push(cwd);
  }
  return result;
}

function packageProject(path: string, source: string, files: Map<string, string>): Project {
  const cwd = posix.dirname(path);
  const result: Project = { path, cwd, runner: null, version: null, status: 'no-suite', sources: [path], commands: [], tools: [], environments: [], testIncludes: [], unresolved: [] };
  const parsed = manifestSchema.safeParse(parseJson(source));
  if (!parsed.success) return { ...result, status: 'ambiguous', unresolved: ['Unreadable package manifest.'] };
  const { scripts, dependencies, devDependencies } = parsed.data;
  result.commands = Object.entries(scripts ?? {}).filter(([key]) => /^test(?::|$)/.test(key)).map(([, value]) => value);
  const commands = result.commands.join('\n');
  const declared = { ...dependencies, ...devDependencies };
  const runners = [
    Object.hasOwn(declared, 'vitest') && 'vitest',
    Object.hasOwn(declared, 'jest') && 'jest',
    /\bnode\b[^\n;&]*\s--test(?:\s|$)/.test(commands) && 'node-test',
    /\bbun\s+test\b/.test(commands) && 'bun-test',
    /\bplaywright\s+test\b/.test(commands) && 'playwright',
  ].filter((runner): runner is string => Boolean(runner));
  if (runners.length > 1) return { ...result, status: 'ambiguous', unresolved: [`Multiple native runners: ${runners.join(', ')}`] };
  result.runner = runners[0] ?? null;
  result.tools = Object.keys(declared).filter((name) => /fast-check|stryker|coverage|convex-test|vitest-pool-workers|vitest\/browser/.test(name)).sort();
  if (!result.runner) return result;
  if (result.runner === 'node-test' || result.runner === 'bun-test') {
    const runtime = result.runner === 'node-test' ? '.node-version' : '.bun-version';
    const pin = ancestors(cwd).map((folder) => posix.join(folder, runtime)).find((file) => files.has(file));
    if (pin) {
      result.sources.push(pin);
      const version = files.get(pin)?.trim().replace(/^v/, '');
      if (version && exactVersion.test(version)) {
        return { ...result, version, status: supportsFramework(result.runner, version) ? 'supported' : 'requires-qualification' };
      }
    }
    return { ...result, status: 'ambiguous', unresolved: ['Confirm the runtime version used by the native test command.'] };
  }
  if (result.runner !== 'vitest') return { ...result, status: 'unsupported' };
  const directoryChain = ancestors(cwd);
  const lockDirectory = directoryChain.find((directory) =>
    ['package-lock.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock'].some((name) => files.has(posix.join(directory, name))));
  if (lockDirectory) {
    const lockPath = posix.join(lockDirectory, 'package-lock.json');
    const bunPath = posix.join(lockDirectory, 'bun.lock');
    const lock = npmLock.safeParse(parseJson(files.get(lockPath)));
    if (lock.success && !files.has(bunPath)) {
      result.sources.push(lockPath);
      for (const directory of directoryChain) {
        const relative = posix.relative(lockDirectory, directory);
        const found = lock.data.packages[posix.join(relative, 'node_modules/vitest')]?.version;
        if (found) { result.version = found; break; }
        if (directory === lockDirectory) break;
      }
    } else if (!files.has(lockPath) && files.has(bunPath)) {
      result.sources.push(bunPath);
      const candidates = [...(files.get(bunPath) ?? '').matchAll(/^\s*"([^"\n]*)":\s*\["vitest@(\d+\.\d+\.\d+)"/gm)];
      const versions = new Set(candidates.map((match) => match[2]));
      if (versions.size === 1) result.version = candidates[0]?.[2] ?? null;
    }
  }
  if (result.version && declared.vitest && exactVersion.test(declared.vitest) && declared.vitest !== result.version) {
    return { ...result, version: null, status: 'ambiguous', unresolved: ['Vitest manifest pin disagrees with the lockfile.'] };
  }
  if (!result.version) return { ...result, status: 'ambiguous', unresolved: ['Vitest version could not be resolved from a lockfile.'] };
  const config = [...files.keys()].filter((file) => directoryChain.includes(posix.dirname(file)) &&
    /^(?:vite|vitest)\.config\./.test(posix.basename(file)));
  result.sources.push(...config);
  for (const path of config) {
    const text = files.get(path) ?? '';
    for (const match of text.matchAll(/\benvironment:\s*['"]([\w-]+)['"]/g)) {
      if (match[1] && !result.environments.includes(match[1])) result.environments.push(match[1]);
    }
    for (const match of text.matchAll(/\binclude:\s*\[([^\]\n]*)\]/g)) {
      for (const pattern of (match[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)) {
        if (pattern[1] && !result.testIncludes.includes(pattern[1])) result.testIncludes.push(pattern[1]);
      }
    }
  }
  if (result.tools.includes('@cloudflare/vitest-pool-workers')) result.environments.push('workers');
  if (result.tools.includes('@vitest/browser') || result.tools.includes('@vitest/browser-playwright')) result.environments.push('browser');
  if (config.length) result.unresolved.push('Configuration literals are hints. Confirm project selection, inclusion and environment with the native runner.');
  result.status = supportsFramework('vitest', result.version) ? 'supported' : 'requires-qualification';
  return result;
}

function dotnetProject(path: string, source: string, files: Map<string, string>): Project | undefined {
  const cwd = posix.dirname(path);
  const references = source.replace(/<!--[\s\S]*?-->/g, '').match(/<PackageReference\b[^>]*\bInclude=["'](?:TUnit|xunit(?:\.v3)?|NUnit|MSTest(?:\.TestFramework)?)["'][^>]*>/gi) ?? [];
  if (references.length === 0) return undefined;
  const result: Project = { path, cwd, runner: null, version: null, status: 'ambiguous', sources: [path], commands: [], tools: [], environments: [], testIncludes: [], unresolved: [] };
  if (references.length !== 1) return { ...result, unresolved: ['Multiple or conditional test-runner references.'] };
  const reference = references[0] ?? '';
  result.runner = /Include=["']([^"']+)/i.exec(reference)?.[1]?.toLowerCase() ?? null;
  result.tools = ['FsCheck', 'Testcontainers', 'CodeCoverage'].filter((name) => source.includes(name));
  if (result.runner !== 'tunit') return { ...result, status: 'unsupported' };
  if (/\bCondition\s*=|<Import\b/i.test(source)) return { ...result, unresolved: ['MSBuild conditions or imports require native resolution.'] };
  let version = /\b(?:VersionOverride|Version)=["']([^"']+)/.exec(reference)?.[1];
  if (!version) {
    const props = ancestors(cwd).map((directory) => posix.join(directory, 'Directory.Packages.props')).find((file) => files.has(file));
    if (props) {
      result.sources.push(props);
      const central = (files.get(props) ?? '').replace(/<!--[\s\S]*?-->/g, '');
      const item = central.match(/<PackageVersion\b[^>]*\bInclude=["']TUnit["'][^>]*>/gi) ?? [];
      if (item.length === 1 && !/\bCondition\s*=|<Import\b/i.test(central)) version = /\bVersion=["']([^"']+)/.exec(item[0] ?? '')?.[1];
    }
  }
  if (!version || !exactVersion.test(version)) return { ...result, unresolved: ['TUnit version requires native MSBuild resolution.'] };
  result.version = version;
  result.environments.push('dotnet');
  result.status = supportsFramework('tunit', version) ? 'supported' : 'requires-qualification';
  result.unresolved.push('Confirm the native command and test inclusion from repository CI.');
  return result;
}

export function inspectProject(snapshot: Snapshot): z.infer<typeof inspectSuccess> {
  const files = new Map(snapshot.files.map(({ path, text }) => [path, text]));
  const projects: Project[] = [];
  for (const [path, source] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (snapshot.project && path !== snapshot.project) continue;
    const project = posix.basename(path) === 'package.json' ? packageProject(path, source, files)
      : path.endsWith('.csproj') ? dotnetProject(path, source, files) : undefined;
    if (project) projects.push(project);
  }
  return { ok: true, projects };
}
