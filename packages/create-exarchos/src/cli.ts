import type { CliArgs, Environment } from './types.js';

const VALID_ENVS: Environment[] = ['claude-code', 'copilot-cli', 'cursor', 'generic-mcp', 'cli'];

export function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    interactive: true,
    companions: { exclude: [] },
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--yes' || arg === '-y') {
      result.interactive = false;
      continue;
    }

    if (arg === '--env') {
      const value = argv[++i];
      if (!value || !VALID_ENVS.includes(value as Environment)) {
        throw new Error(`Invalid environment: ${value}. Valid options: ${VALID_ENVS.join(', ')}`);
      }
      result.env = value as Environment;
      continue;
    }

    if (arg.startsWith('--no-')) {
      const companionId = arg.slice(5); // Remove '--no-'
      result.companions.exclude.push(companionId);
      continue;
    }
  }

  return result;
}
