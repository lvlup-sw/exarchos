import { readFile } from 'node:fs/promises';
import { Command, CommanderError } from 'commander';
import { describeOperations, dispatch, failure } from '../contract/operations.js';
import { frameworkVersions } from '../contract/targets.js';
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

  program.command('init')
    .description('Propose a request and throwing binding stubs for a native suite.')
    .argument('<name>')
    .requiredOption('--framework <framework>', 'Use tunit or vitest.')
    .option('--framework-version <version>', 'Use an advertised framework version.')
    .option('--method <method>', 'Use property, metamorphic, differential, or stateful.', 'property')
    .option('--project <path>', 'C# test project path.')
    .option('--namespace <name>', 'C# binding and test namespace.')
    .option('--directory <path>', 'Repository-relative directory for proposed files.')
    .option('--property-ref <reference>', 'Reference to the accepted property.')
    .option('--domain <file>', 'Read the proposed argument domain from JSON.')
    .option('--json', 'Print the structured scaffold result as JSON.')
    .action(async (name: string, options: {
      framework: string; frameworkVersion?: string; method: string; project?: string;
      namespace?: string; directory?: string; propertyRef?: string; domain?: string; json?: boolean;
    }) => {
      const input: Record<string, unknown> = {
        name, framework: options.framework, method: options.method,
        frameworkVersion: options.frameworkVersion ?? Object.entries(frameworkVersions).find(([key]) => key === options.framework)?.[1] ?? 'unknown',
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
        render(invoke(operation.name, input), Boolean(options.json));
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
