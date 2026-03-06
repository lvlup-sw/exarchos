import { Command } from 'commander';
import { TOOL_REGISTRY } from '../registry.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import { addFlagsFromSchema, coerceFlags, toKebab } from './schema-to-flags.js';
import { prettyPrint } from './cli-format.js';
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
    .version('1.1.0');

  // ─── Auto-generated tool commands ──────────────────────────────────────────

  for (const tool of TOOL_REGISTRY) {
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
        const args = { action: action.name, ...coerceFlags(opts, action.schema) };
        const result = await dispatch(tool.name, args, ctx);

        if (opts.json) {
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
        const schema = resolveSchemaRef(ref);
        process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
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

  return program;
}
