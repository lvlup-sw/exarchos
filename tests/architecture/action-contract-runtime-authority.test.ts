/**
 * Dispatch reads the live registry. Compiled descriptors are a projection
 * (CLI, MCP, describe, oracle), not the runtime authority for a call.
 *
 * @oracle-sources: ../../src/dispatch, ../../src/contract/compiler/descriptors.ts, ../../src/registry.ts
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DISPATCH_ROOT = path.join(REPO_ROOT, 'src/dispatch');
const DISPATCH_CORE = path.join(DISPATCH_ROOT, 'core/dispatch.ts');
const DENOMINATOR = path.join(REPO_ROOT, 'src/contract/registered-actions-denominator.ts');

const COMPILED_AUTHORITY_IMPORT = /from\s+['"][^'"]*(?:contract\/compiler(?:\/(?:descriptors|generate|fixtures|compile))?|compiler\/generated\/proof-fixtures)(?:\.js)?['"]/;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
}

function dispatchSources(): readonly { readonly file: string; readonly source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      out.push({
        file: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
        source: stripComments(readFileSync(full, 'utf8')),
      });
    }
  };
  walk(DISPATCH_ROOT);
  return out;
}

function compiledDescriptorImports(source: string): readonly string[] {
  const hits: string[] = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('import')) continue;
    if (COMPILED_AUTHORITY_IMPORT.test(trimmed)) hits.push(trimmed);
  }
  return hits;
}

describe('dispatch compiled-descriptor authority', () => {
  it('Dispatch_CompiledDescriptors_AreNotRuntimeAuthority', () => {
    const denominator = readFileSync(DENOMINATOR, 'utf8');
    expect(denominator).toMatch(/export function measureLiveRegisteredActions/);
    expect(denominator).toMatch(/export function snapshotMatchesLiveRegistry/);
    expect(denominator).toMatch(/export function generatedProjectionsMatchLive/);

    const sources = dispatchSources();
    expect(sources.length, 'dispatch tree resolved to nothing').toBeGreaterThan(10);

    const offenders = sources.flatMap(({ file, source }) =>
      compiledDescriptorImports(source).map((line) => `${file}: ${line}`),
    );
    expect(offenders, `dispatch imported compiled descriptors as runtime authority:\n${offenders.join('\n')}`).toEqual(
      [],
    );

    const dispatchCore = readFileSync(DISPATCH_CORE, 'utf8');
    expect(statSync(DISPATCH_CORE).isFile()).toBe(true);
    expect(dispatchCore).toMatch(/from ['"]\.\.\/\.\.\/registry\.js['"]/);
    expect(dispatchCore).toMatch(/\bfindActionInRegistry\b/);
    expect(dispatchCore).toMatch(/\bgetFullRegistry\b/);
    expect(dispatchCore).not.toMatch(/\bcompileDescriptor\b/);
    expect(dispatchCore).not.toMatch(/\bproof-fixtures\b/);

    const injected = compiledDescriptorImports(
      `import { compileDescriptor } from '../../contract/compiler/descriptors.js';\n`,
    );
    expect(injected).toEqual([
      "import { compileDescriptor } from '../../contract/compiler/descriptors.js';",
    ]);
  });
});
