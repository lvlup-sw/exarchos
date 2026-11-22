// @oracle-sources: ../../../src/testgen/inspection/analyze.ts
import { expect, it } from 'vitest';
import { dispatchInspection } from '../../../src/testgen/contract/operations.js';

it('resolves scoped TUnit pins and does not qualify conditional references', () => {
  const central = (version: string) => `<Project><ItemGroup><PackageVersion Include = "TUnit" Version = "${version}" /></ItemGroup></Project>`;
  const project = '<Project><ItemGroup><PackageReference Include = "TUnit" /></ItemGroup></Project>';
  const result = dispatchInspection({ files: [
    { path: 'Directory.Packages.props', text: central('1.83.8') },
    { path: 'Sample/Directory.Packages.props', text: central('1.2.11') },
    { path: 'Sample/Tests/Tests.csproj', text: project },
    { path: 'Tests/Tests.csproj', text: project },
    { path: 'Tests/Conditional.csproj', text: project.replace('<ItemGroup>', '<ItemGroup Condition="x">') },
  ] });
  expect(result).toMatchObject({ ok: true, projects: [
    { path: 'Sample/Tests/Tests.csproj', status: 'supported', version: '1.2.11' },
    { path: 'Tests/Conditional.csproj', status: 'ambiguous', version: null },
    { path: 'Tests/Tests.csproj', status: 'supported', version: '1.83.8' },
  ] });
});

it('distinguishes a workspace lock resolution from a manifest range', () => {
  const manifest = JSON.stringify({ devDependencies: { vitest: '^5.0.0' }, scripts: { test: 'bun test:unit', 'test:unit': 'vitest run' } });
  const files = [
    { path: 'packages/@demo app/package.json', text: manifest },
    { path: 'package-lock.json', text: JSON.stringify({ packages: {
      'node_modules/vitest': { version: '4.1.12' },
      'packages/@demo app/node_modules/vitest': { version: '5.1.0' },
    } }) },
  ];
  expect(dispatchInspection({ files })).toMatchObject({ ok: true, projects: [
    { version: '5.1.0', status: 'supported', commands: ['bun test:unit', 'vitest run'] },
  ] });
  expect(dispatchInspection({ files: files.slice(0, 1) })).toMatchObject({ ok: true, projects: [
    { version: null, status: 'ambiguous' },
  ] });
});

it('rejects metadata traversal paths and duplicate entries', () => {
  expect(dispatchInspection({ files: [{ path: '../package.json', text: '{}' }] })).toMatchObject({ ok: false });
  const project = { path: 'package.json', text: '{}' };
  expect(dispatchInspection({ files: [project, project] })).toMatchObject({ ok: false });
});
