import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const support = fileURLToPath(new URL('../../tests/support/testgen/native/', import.meta.url));
const methods = ['property', 'metamorphic', 'differential', 'stateful'];
const domain = { kind: 'record', fields: {
  enabled: { kind: 'boolean' },
  ['key\u2028']: { kind: 'boolean' },
  text: { kind: 'string', alphabet: 'aé😀\u0085\u2028\u2029', minLength: 0, maxLength: 4 },
  count: { kind: 'integer', min: '-99999999999999999999999', max: '99999999999999999999999' },
  score: { kind: 'number', min: -1e308, max: 1e308 },
  items: { kind: 'array', element: { kind: 'nullable', value: { kind: 'enum', values: ['red', 'blue', '\u0085', '\u2028', '\u2029'] } }, minLength: 0, maxLength: 3 },
} };

export function checkNativeV2(scratch, testgen, npm, options, checkedOutput) {
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--save-dev', 'vitest@3.2.7', 'typescript@5.9.3', '@types/node@20']);
  for (const framework of ['tunit', 'vitest']) {
    const folder = framework === 'tunit' ? 'native-cs' : 'native-ts';
    const cwd = join(scratch, folder);
    mkdirSync(cwd);
    const extension = framework === 'tunit' ? 'cs' : 'ts';
    for (const name of ['TypedBinding', 'StatefulBinding']) {
      writeFileSync(join(cwd, `${name}.${extension}`), readFileSync(join(support, `${name}.${extension}`)));
    }
    if (framework === 'tunit') writeFileSync(join(cwd, 'Smoke.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
<PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><GenerateDocumentationFile>true</GenerateDocumentationFile><TreatWarningsAsErrors>true</TreatWarningsAsErrors><NuGetAudit>false</NuGetAudit></PropertyGroup>
<ItemGroup><PackageReference Include="TUnit" Version="1.2.11" /></ItemGroup>
</Project>`);
    const requests = methods.map((method) => {
      const binding = method === 'stateful' ? 'StatefulBinding' : 'TypedBinding';
      return {
        contractVersion: 2, framework, frameworkVersion: framework === 'tunit' ? '1.2.11' : '3.2.7',
        propertyRef: `installed/${method}/\u2028`, assumptions: [], reduction: { maxAttempts: 64 },
        target: framework === 'tunit'
          ? { project: `${folder}/Smoke.csproj`, path: `${folder}/${method}.cs`, namespace: 'Smoke', className: `Generated${method}`, binding: `Smoke.${binding}` }
          : { path: `${folder}/${method}.test.ts`, bindingModule: `${folder}/${binding}.ts` },
        ...(method === 'stateful' ? {
          operations: ['put', 'remove'].map((name) => ({ name, domain: { kind: 'enum', values: ['a', 'b', 'c'] } })),
          histories: [[{ operation: 'put', args: 'a' }, { operation: 'put', args: 'b' }, { operation: 'remove', args: 'a' }]],
          generation: { seed: 42, count: 5, maxSteps: 10, maxAttempts: 64 },
        } : {
          domain, cases: [{ enabled: true, ['key\u2028']: false, text: '\u0085\u2028\u2029', count: '17', score: 1, items: ['\u2029', null] }],
          generation: { seed: 17, count: 12, maxAttempts: 100 },
        }),
      };
    });
    const discovered = new Map();
    function apply(result, path) {
      assert.equal(result.ok, true, JSON.stringify(result));
      discovered.set(path, result.fixture.cases?.length ?? result.fixture.scenarios.length);
      rmSync(join(scratch, path), { force: true });
      const patch = join(scratch, 'generated.patch');
      writeFileSync(patch, result.patch);
      checkedOutput(spawnSync('git', ['apply', patch], options()), 'git apply');
    }
    for (const [index, method] of methods.entries()) {
      const path = join(scratch, `${method}.request.json`);
      writeFileSync(path, JSON.stringify(requests[index]));
      apply(testgen([`generate_${method}_tests`, '--input', path]), requests[index].target.path);
    }
    function native(fault = false) {
      const env = { ...process.env, TESTGEN_FAULT: fault ? '1' : '0' };
      const result = framework === 'tunit'
        ? spawnSync('dotnet', ['run', '--project', `${folder}/Smoke.csproj`, '-c', 'Release'], { ...options(), env })
        : spawnSync(process.execPath, [join(scratch, 'node_modules/vitest/vitest.mjs'), 'run', folder], { ...options(), env });
      if (result.error) throw result.error;
      const output = result.stdout + result.stderr;
      if (fault) assert.notEqual(result.status, 0, output);
      else assert.equal(result.status, 0, output);
      assert.doesNotMatch(output, /error CS\d+/);
      const expectedCount = [...discovered.values()].reduce((sum, count) => sum + count, 0);
      const total = framework === 'tunit' ? output.match(/total:\s*(\d+)\b/i)
        : output.match(/Tests\s+[^\n]*\((\d+)\)/);
      assert.ok(total, `Native discovery summary is missing: ${output}`);
      assert.equal(Number(total[1]), expectedCount, output);
      return output;
    }
    function typecheck() {
      if (framework !== 'vitest') return;
      checkedOutput(spawnSync(process.execPath, [join(scratch, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', ...requests.map(({ target }) => target.path)], options()), 'typecheck generated TypeScript');
    }
    typecheck();
    native();
    const failures = native(true);
    const records = [...failures.matchAll(/TESTGEN_REPLAY (\{[^\n]+\})/g)].map((match) => JSON.parse(match[1]));
    for (const [index, method] of methods.entries()) {
      const record = records.find((value) => value.method === method && value.caseId === 'Case_1');
      assert.ok(record, `${framework}/${method} must detect its negative control: ${failures}`);
      assert.equal(record.signature, method === 'stateful' ? 'stateful/remove/state-mismatch' : `${method}/oracle-false`);
      if (method === 'stateful') assert.deepEqual(record.histories, [[{ operation: 'put', args: 'a' }, { operation: 'remove', args: 'a' }]]);
      const path = join(scratch, `${method}.replay.json`);
      writeFileSync(path, JSON.stringify(record));
      apply(testgen(['replay', '--input', join(scratch, `${method}.request.json`), '--fixture', path]), requests[index].target.path);
    }
    typecheck();
    const replayed = native(true);
    const replays = [...replayed.matchAll(/TESTGEN_REPLAY (\{[^\n]+\})/g)].map((match) => JSON.parse(match[1]));
    for (const method of methods) {
      const original = records.find((value) => value.method === method && value.caseId === 'Case_1');
      const replay = replays.find((value) => value.method === method && value.caseId === 'Case_1');
      assert.ok(replay, `${framework}/${method} must replay: ${replayed}`);
      assert.equal(replay.signature, original.signature);
      assert.deepEqual(replay.cases ?? replay.histories, original.cases ?? original.histories);
      assert.equal(replay.reduction.attempts, 0);
    }
    native();
    process.stdout.write(`Installed ${framework}: all four methods pass, detect controls, and replay concrete failures.\n`);
  }
}
