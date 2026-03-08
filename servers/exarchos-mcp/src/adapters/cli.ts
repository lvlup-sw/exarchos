import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getFullRegistry } from '../registry.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import { addFlagsFromSchema, coerceFlags, validateRequiredBooleans, toKebab } from './schema-to-flags.js';
import { prettyPrint, printError } from './cli-format.js';
import { listSchemas, resolveSchemaRef } from './schema-introspection.js';
import { createMcpServer } from './mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// ─── CLI Command Tree Generator ─────────────────────────────────────────────

/**
 * Builds a Commander program from the TOOL_REGISTRY.
 *
 * Each composite tool becomes a top-level command (with `exarchos_` prefix stripped),
 * and each action becomes a subcommand with flags auto-generated from Zod schemas.
 *
 * Also registers the `schema` introspection command and `mcp` server mode.
 */
export function buildCli(ctx: DispatchContext): Command {
  const program = new Command('exarchos')
    .description('Agent governance for AI coding — event-sourced SDLC workflows')
    .version('2.4.0');

  // ─── Auto-generated tool commands ──────────────────────────────────────────

  for (const tool of getFullRegistry()) {
    const toolName = tool.name.replace(/^exarchos_/, '');
    const toolCmd = program
      .command(tool.cli?.alias ?? toolName)
      .description(tool.description);

    for (const action of tool.actions) {
      const actionCmd = toolCmd
        .command(action.cli?.alias ?? action.name)
        .description(action.description);

      addFlagsFromSchema(actionCmd, action.schema, action.cli?.flags);

      actionCmd.action(async (opts: Record<string, unknown>) => {
        const { json, ...flagOpts } = opts;

        // Validate required booleans (Commander can't enforce --flag vs --no-flag)
        const missingBools = validateRequiredBooleans(flagOpts, action.schema);
        if (missingBools.length > 0) {
          printError({
            code: 'MISSING_REQUIRED',
            message: `Required option(s) not specified: ${missingBools.join(', ')}`,
          });
          process.exitCode = 1;
          return;
        }

        const args = { action: action.name, ...coerceFlags(flagOpts, action.schema) };
        const result = await dispatch(tool.name, args, ctx);

        if (json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          prettyPrint(result, action.cli?.format);
        }
      });
    }
  }

  // ─── Schema introspection command ──────────────────────────────────────────

  program
    .command('schema [ref]')
    .description('Inspect action schemas. Without args, lists all. With "tool.action", shows JSON Schema.')
    .action(async (ref?: string) => {
      if (!ref) {
        const schemas = listSchemas();
        for (const tool of schemas) {
          process.stdout.write(`\n${tool.tool}:\n`);
          for (const action of tool.actions) {
            process.stdout.write(`  ${action.name} — ${action.description}\n`);
          }
        }
      } else {
        try {
          const schema = resolveSchemaRef(ref);
          process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
        } catch (err) {
          printError({
            code: 'INVALID_SCHEMA_REF',
            message: err instanceof Error ? err.message : String(err),
          });
          process.exitCode = 1;
        }
      }
    });

  // ─── MCP server mode command ───────────────────────────────────────────────

  program
    .command('mcp')
    .description('Start Exarchos as an MCP server (stdio)')
    .action(async () => {
      const server = createMcpServer(ctx);
      const transport = new StdioServerTransport();
      await server.connect(transport);
    });

  // ─── Init scaffolding command ─────────────────────────────────────────────

  program
    .command('init')
    .description('Create an exarchos.config.ts scaffolding file')
    .action(async () => {
      const configPath = path.join(process.cwd(), 'exarchos.config.ts');

      if (fs.existsSync(configPath)) {
        process.stdout.write(`exarchos.config.ts already exists — not overwriting.\n`);
        return;
      }

      const template = `import { defineConfig } from '@lvlup-sw/exarchos';

export default defineConfig({
  // Define custom workflows here
  // workflows: {
  //   'my-workflow': {
  //     phases: ['start', 'implement', 'review', 'done'],
  //     initialPhase: 'start',
  //     transitions: [
  //       { from: 'start', to: 'implement', event: 'begin' },
  //       { from: 'implement', to: 'review', event: 'submit' },
  //       { from: 'review', to: 'done', event: 'approve' },
  //       { from: 'review', to: 'implement', event: 'request-changes' },
  //     ],
  //   },
  // },
});
`;

      fs.writeFileSync(configPath, template);
      process.stdout.write(`Created exarchos.config.ts\n`);
      process.stdout.write(`\nGetting started:\n`);
      process.stdout.write(`  1. Uncomment and customize the workflow definition\n`);
      process.stdout.write(`  2. Run \`exarchos wf init -f my-feature -t feature\` to start a workflow\n`);
      process.stdout.write(`  3. Run \`exarchos vw ls\` to see active workflows\n`);
    });

  return program;
}
