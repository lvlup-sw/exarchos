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
import {
  declaredEmissions,
  effectPlanFromContract,
  records,
} from '../../src/dispatch/core/effect-carrier.js';
import { verifierDeclaredEmissions } from '../../src/dispatch/core/interceptors/emission-verifier.js';
import { contractEmissionsOf, declared, none } from '../../src/registry/action-contract.js';

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

describe('nested emission authority', () => {
  it('sibling autoEmits is not the declared-emission authority', () => {
    const sibling = [
      { event: 'gate.executed', condition: 'always' as const, owner: 'sibling', role: 'primary' as const },
    ];
    const nested = {
      event: 'workflow.started',
      condition: 'always' as const,
      owner: 'workflow',
      role: 'primary' as const,
    };
    const contract = {
      requires: none('architecture probe'),
      ensures: none('architecture probe'),
      needs: none('architecture probe'),
      touches: { frame: 'single-machine' as const, resources: none('architecture probe') },
      executionAuthority: { kind: 'local' as const },
      replay: { kind: 'safe-repeat' as const },
      emissions: declared(nested),
    };

    expect(
      contractEmissionsOf({ autoEmits: sibling, actionContract: contract }),
    ).toEqual([nested]);
    expect(
      contractEmissionsOf({
        autoEmits: sibling,
        actionContract: { ...contract, emissions: none('reasoned silence') },
      }),
    ).toEqual([]);

    type VerifierRead = (
      contract: Parameters<typeof verifierDeclaredEmissions>[0],
      siblingAutoEmits?: typeof sibling,
    ) => ReturnType<typeof verifierDeclaredEmissions>;
    const read = verifierDeclaredEmissions as VerifierRead;
    expect(read({ emissions: none('reasoned silence') }, sibling)).toBeUndefined();
    expect(read(undefined, sibling)).toBeUndefined();
    expect(read({ emissions: declared(nested) }, sibling)?.map((row) => row.event)).toEqual([
      'workflow.started',
    ]);

    const plan = effectPlanFromContract(
      {
        effectClass: 'filesystem',
        owner: 'effect-owner',
        description: 'architecture probe',
        emits: records({ event: 'gate.executed', when: 'before', owner: 'sibling', role: 'recovery' }),
      },
      { replay: { kind: 'safe-repeat' }, emissions: declared(nested) },
    );
    expect(declaredEmissions(plan)).toEqual([
      { event: 'workflow.started', when: 'before', owner: 'workflow', role: 'primary' },
    ]);

    const collect = readFileSync(path.join(REPO_ROOT, 'src/contract/reachability/collect.ts'), 'utf8');
    expect(collect).toMatch(/contractEmissionsOf/);
    expect(collect).not.toMatch(/action\.autoEmits\s*\?\?/);

    const census = readFileSync(path.join(REPO_ROOT, 'src/events/registration-validate.ts'), 'utf8');
    expect(census).toMatch(/contractEmissionsOf/);
    expect(census).not.toMatch(/action\.autoEmits\s*\?\?/);

    const verifier = readFileSync(
      path.join(REPO_ROOT, 'src/dispatch/core/interceptors/emission-verifier.ts'),
      'utf8',
    );
    expect(verifier).not.toMatch(/return siblingAutoEmits/);
  });
});
