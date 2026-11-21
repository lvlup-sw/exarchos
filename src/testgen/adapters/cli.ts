import { collectMetadata } from '../inspection/collect.js';
import { readFile } from 'node:fs/promises';
import { Command, CommanderError } from 'commander';
import { describeOperations, dispatch, dispatchInspection, failure } from '../contract/operations.js';
import { qualifiedVersions } from '../contract/targets.js';
import type { GenerationResult } from '../contract/schemas.js';
import { commandMetadata } from './cli-metadata.js';

type Write = (text: string) => void;

export async function runCli(args: string[], stdout: Write, stderr: Write, invoke = dispatch): Promise<number> {
  const program = new Command('testgen')
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: stderr });
  let exitCode = 0;

  function render(result: GenerationResult, json: boolean): void {
    if (json) stdout(`${JSON.stringify(result)}\n`);
    else if (result.ok) stdout(result.patch);
    if (!result.ok) {
      stderr(`${result.error.code}: ${result.error.message}\n`);
      exitCode = commandMetadata.errors[result.error.code];
    }
  }

  program.command('describe')
    .argument('[operation]')
    .option('--json', 'Print command metadata as JSON.')
    .action((name: string | undefined, options: { json?: boolean }) => {
      const declared = commandMetadata.operations.filter((op) => name === undefined || op.name === name);
      if (declared.length === 0) {
        render(failure('INVALID_INPUT', 'Unknown operation.'), Boolean(options.json));
        return;
      }
      const metadata = describeOperations();
      stdout(options.json
        ? `${JSON.stringify({ ...metadata, operations: metadata.operations.filter((op) => name === undefined || op.name === name) })}\n`
        : `${metadata.capabilities.frameworks.map(({ framework, version }) => `${framework} ${version}`).join(', ')}\n${declared.map((op) => `${op.name}: ${op.description}`).join('\n')}\n`);
    });

  function renderInspection(input: unknown) {
    const result = dispatchInspection(input);
    if (!result.ok) render(result, true);
    else stdout(`${JSON.stringify(result)}\n`);
  }

  program.command('inspect')
    .description('Inspect tracked repository test metadata.')
    .option('--root <path>', 'Git repository root.', '.')
    .option('--project <path>', 'Repository-relative manifest or test project.')
    .option('--json', 'Print project metadata as JSON.')
    .action(async ({ root, project }: { root: string; project?: string }) => {
      try { renderInspection({ files: await collectMetadata(root), project }); }
      catch { render(failure('INVALID_INPUT', 'Could not collect bounded metadata from the repository root.'), true); }
    });

  program.command('init')
    .description('Propose a request and throwing binding stubs for a native suite.')
    .argument('<name>')
    .option('--framework <framework>', 'Use a framework advertised by describe.')
    .option('--inspect-project <path>', 'Select a test project from tracked repository metadata.')
    .option('--framework-version <version>', 'Use an advertised framework version.')
    .option('--method <method>', 'Use property, metamorphic, differential, or stateful.', 'property')
    .option('--project <path>', 'C# test project path.')
    .option('--namespace <name>', 'C# binding and test namespace.')
    .option('--directory <path>', 'Repository-relative directory for proposed files.')
    .option('--property-ref <reference>', 'Reference to the accepted property.')
    .option('--domain <file>', 'Read the proposed argument domain from JSON.')
    .option('--json', 'Print the structured scaffold result as JSON.')
    .action(async (name: string, options: {
      framework?: string; inspectProject?: string; frameworkVersion?: string; method: string; project?: string;
      namespace?: string; directory?: string; propertyRef?: string; domain?: string; json?: boolean;
    }) => {
      if (options.inspectProject) {
        let selected;
        try {
          const result = dispatchInspection({ files: await collectMetadata('.'), project: options.inspectProject });
          if (result.ok && result.projects.length === 1) selected = result.projects[0];
        } catch {
          render(failure('INVALID_INPUT', 'Could not inspect the selected repository project.'), Boolean(options.json));
          return;
        }
        if (selected?.status !== 'supported' || !selected.runner || !selected.version
          || (options.framework && options.framework !== selected.runner)
          || (options.frameworkVersion && options.frameworkVersion !== selected.version)) {
          render(failure('INVALID_INPUT', 'Select an unambiguous supported project or specify the framework explicitly.'), Boolean(options.json));
          return;
        }
        options.framework = selected.runner;
        options.frameworkVersion = selected.version;
        if (selected.runner === 'tunit') options.project ??= selected.path;
        else if (selected.cwd !== '.') options.directory ??= `${selected.cwd}/tests/generated`;
      }
      if (!options.framework) {
        render(failure('INVALID_INPUT', 'Supply --framework or --inspect-project.'), Boolean(options.json));
        return;
      }
      const input: Record<string, unknown> = {
        name, framework: options.framework, method: options.method,
        frameworkVersion: options.frameworkVersion ?? Object.entries(qualifiedVersions).find(([key]) => key === options.framework)?.[1][0] ?? 'unknown',
      };
      for (const key of ['project', 'namespace', 'directory', 'propertyRef'] as const) {
        if (options[key] !== undefined) input[key] = options[key];
      }
      if (options.domain) {
        try { input.domain = JSON.parse(await readFile(options.domain, 'utf8')); }
        catch {
          render(failure('INVALID_INPUT', 'Could not read a JSON domain from --domain.'), Boolean(options.json));
          return;
        }
      }
      render(invoke('scaffold_tests', input), Boolean(options.json));
    });

  program.command('replay')
    .description('Rebuild tests from an original request and a native failure record.')
    .requiredOption('--input <file>', 'Read the original generation request.')
    .requiredOption('--fixture <file>', 'Read a replay JSON record or native test log.')
    .option('--case <id>', 'Select one Case_N record from a log.')
    .option('--json', 'Print the structured generation result as JSON.')
    .action(async (options: { input: string; fixture: string; case?: string; json?: boolean }) => {
      let request: unknown;
      let fixture: unknown;
      try {
        request = JSON.parse(await readFile(options.input, 'utf8'));
        fixture = selectReplay(await readFile(options.fixture, 'utf8'), options.case);
      } catch (error) {
        const message = error instanceof ReplaySelectionError ? error.message : 'Could not read the request and replay fixture.';
        render(failure('INVALID_INPUT', message), Boolean(options.json));
        return;
      }
      render(invoke('replay_tests', { request, fixture }), Boolean(options.json));
    });

  for (const operation of commandMetadata.operations) {
    program.command(operation.name).description(operation.description)
      .requiredOption('--input <file>', 'Read the operation request from a JSON file.')
      .option('--json', 'Print the structured result as JSON.')
      .action(async (options: { input: string; json?: boolean }) => {
        let input: unknown;
        try {
          input = JSON.parse(await readFile(options.input, 'utf8'));
        } catch {
          render(failure('INVALID_INPUT', 'Could not read a JSON request from --input.'), Boolean(options.json));
          return;
        }
        if (operation.name === 'inspect_project') renderInspection(input);
        else render(invoke(operation.name, input), Boolean(options.json));
      });
  }
  try {
    await program.parseAsync(args, { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : commandMetadata.errors.INVALID_INPUT;
    }
    stderr('INTERNAL_ERROR: CLI failed.\n');
    return commandMetadata.errors.INTERNAL_ERROR;
  }
}

class ReplaySelectionError extends Error {}

function selectReplay(text: string, caseId?: string): unknown {
  let records: unknown[];
  try {
    records = [JSON.parse(text)];
  } catch {
    const marker = 'TESTGEN_REPLAY ';
    const lines = text.split('\n').filter((line) => line.includes(marker));
    if (lines.length === 0) throw new ReplaySelectionError('No TESTGEN_REPLAY record was found.');
    records = lines.map((line) => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
  }
  const matching = caseId === undefined ? records : records.filter((record) =>
    record !== null && typeof record === 'object' && 'caseId' in record && record.caseId === caseId);
  if (matching.length !== 1) throw new ReplaySelectionError('Select exactly one replay record with --case, or provide a single-record JSON file.');
  return matching[0];
}
