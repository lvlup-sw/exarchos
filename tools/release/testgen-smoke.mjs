import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackagedMcp } from './testgen-mcp-smoke.mjs';
import { checkNativeV2 } from './testgen-native-smoke.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'testgen install '));
const npmCli = process.env.npm_execpath;

function options(cwd = scratch) {
  return { cwd, encoding: 'utf8', timeout: 180_000 };
}

function checkedOutput(result, command, expectedStatus = 0) {
  if (result.error) throw result.error;
  assert.equal(result.status, expectedStatus, [command, result.stdout, result.stderr].join('\n'));
  return result.stdout;
}

function npm(args, cwd, expectedStatus) {
  assert.ok(npmCli, 'Run the smoke check with npm run testgen:smoke.');
  const result = spawnSync(process.execPath, [npmCli, ...args], options(cwd));
  return checkedOutput(result, `npm ${args.join(' ')}`, expectedStatus);
}

function testgen(args, expectedStatus) {
  return JSON.parse(npm(['run', '--silent', 'testgen', '--', ...args, '--json'], scratch, expectedStatus));
}

try {
  const [pack] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root));
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({
    name: 'testgen-smoke',
    private: true,
    scripts: { testgen: 'testgen' },
  }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', join(scratch, pack.filename)]);

  const bundle = readFileSync(join(scratch, 'node_modules/@lvlup-sw/exarchos/dist/testgen-cli.js'), 'utf8');
  assert.doesNotMatch(bundle, /@modelcontextprotocol\/|better-sqlite3|exarchos\.db/);
  await checkPackagedMcp(join(scratch, 'node_modules/@lvlup-sw/exarchos/dist/testgen-mcp.js'), scratch, testgen(['describe']));

  const requestPath = join(scratch, 'input file.json');
  const project = 'Smoke.csproj';
  const request = {
    framework: 'tunit',
    frameworkVersion: '1.2.11',
    target: {
      namespace: 'Smoke',
      observe: 'Smoke.Binding.Observe',
      precondition: 'Smoke.Binding.IsValid',
      project,
    },
    propertyRef: 'smoke/identity',
    assumptions: ['Each case contains one signed integer.'],
    cases: [['-9223372036854775808'], ['0']],
  };

  writeFileSync(join(scratch, project), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <NuGetAudit>false</NuGetAudit>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="TUnit" Version="1.2.11" />
  </ItemGroup>
</Project>
`);
  writeFileSync(join(scratch, 'Binding.cs'), `namespace Smoke;
internal static class Binding
{
    public static bool IsValid(long[] input) => input.Length == 1;
    public static long Observe(long[] input) => input[0];
    public static bool Predicate(long[] input, long actual) => actual == input[0];
    public static long[] Advance(long[] input) => [input[0] + 1];
    public static bool Advances(long[] source, long[] follow, long before, long after) => after == before + 1;
}
`);

  for (const [operation, className, bindings] of [
    ['generate_property_tests', 'Check', { predicate: 'Smoke.Binding.Predicate' }],
    ['generate_metamorphic_tests', 'Case_1', { transform: 'Smoke.Binding.Advance', relation: 'Smoke.Binding.Advances' }],
  ]) {
    const [metadata] = testgen(['describe', operation]).operations;
    const schemas = (metadata.inputSchema.anyOf ?? [metadata.inputSchema]).flatMap((schema) => schema.oneOf ?? [schema]);
    const supported = schemas.find(({ properties }) => properties.framework.const === request.framework);
    assert.ok(supported, `Describe must advertise ${request.framework} for ${operation}.`);
    assert.equal(supported.properties.frameworkVersion.const, request.frameworkVersion);
    const input = { ...request, ...bindings, target: { ...request.target, className, path: `${className}.cs` } };
    writeFileSync(requestPath, JSON.stringify(input));
    const result = testgen([operation, '--input', requestPath]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.fixture.cases, request.cases);
    const patch = join(scratch, `${className}.patch`);
    writeFileSync(patch, result.patch);
    checkedOutput(spawnSync('git', ['apply', patch], options()), `git apply ${patch}`);

    writeFileSync(requestPath, JSON.stringify({ ...input, framework: 'TUnit' }));
    assert.equal(testgen([operation, '--input', requestPath], 3).error.code, 'UNSUPPORTED_FRAMEWORK');
    writeFileSync(requestPath, JSON.stringify({ ...input, cases: [] }));
    assert.equal(testgen([operation, '--input', requestPath], 2).error.code, 'INVALID_INPUT');
  }

  const nativeRun = spawnSync('dotnet', ['run', '--project', project, '-c', 'Release', '--', '--minimum-expected-tests', '4'], options());
  const output = checkedOutput(nativeRun, `dotnet run --project ${project}`);
  assert.match(output, /total:\s*4\b/i);
  process.stdout.write('Installed testgen emitted four passing native tests.\n');
  checkNativeV2(scratch, testgen, npm, options, checkedOutput);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
