import type { Environment } from './types.js';
import { getCompanions, getCompanionInstall } from './companions.js';

export interface Choice<T> {
  name: string;
  value: T;
  checked?: boolean;
}

export function buildEnvironmentChoices(_detected: Environment | null): Choice<Environment>[] {
  return [
    { name: 'Claude Code', value: 'claude-code' },
    { name: 'Cursor', value: 'cursor' },
    { name: 'Other MCP client', value: 'generic-mcp' },
    { name: 'Terminal (CLI only)', value: 'cli' },
  ];
}

export function buildCompanionChoices(env: Environment): Choice<string>[] {
  const companions = getCompanions();
  const available = companions.filter(c => getCompanionInstall(c, env) !== undefined);

  return available.map(c => ({
    name: `${c.name} — ${c.description}`,
    value: c.id,
    checked: c.default,
  }));
}
