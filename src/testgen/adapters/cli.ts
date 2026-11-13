import { readFile } from 'node:fs/promises';
import { Command, CommanderError } from 'commander';
import { describeOperations, dispatch, failure } from '../contract/operations.js';
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
      stdout(options.json
        ? `${JSON.stringify({ errors: commandMetadata.errors, operations: describeOperations().operations.filter((op) => name === undefined || op.name === name) })}\n`
        : `${declared.map((op) => `${op.name}: ${op.description}`).join('\n')}\n`);
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
