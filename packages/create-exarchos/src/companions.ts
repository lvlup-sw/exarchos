import type { Companion, CompanionInstall, Environment } from './types.js';

export const COMPANIONS: Companion[] = [
  {
    id: 'axiom', name: 'axiom',
    description: 'backend quality checks (8 dimensions incl. prose quality)',
    default: true,
    install: {
      'claude-code': { plugin: 'axiom@lvlup-sw' },
      'copilot-cli': { skills: 'lvlup-sw/axiom' },
      cursor: { skills: 'lvlup-sw/axiom' },
    },
  },
  {
    id: 'impeccable', name: 'impeccable',
    description: 'frontend design quality (17 skills)',
    default: true,
    install: {
      'claude-code': { plugin: 'impeccable@impeccable' },
      'copilot-cli': { skills: 'pbakaus/impeccable' },
      cursor: { skills: 'pbakaus/impeccable' },
    },
  },
  {
    id: 'serena', name: 'serena',
    description: 'semantic code analysis',
    default: true,
    install: {
      'claude-code': { plugin: 'serena@claude-plugins-official' },
      'copilot-cli': { mcp: { type: 'stdio', command: 'uvx', args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server'] } },
      cursor: { mcp: { type: 'stdio', command: 'uvx', args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server'] } },
    },
  },
  {
    id: 'context7', name: 'context7',
    description: 'library documentation',
    default: true,
    install: {
      'claude-code': { plugin: 'context7@claude-plugins-official' },
      'copilot-cli': { mcp: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
      cursor: { mcp: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
    },
  },
  {
    id: 'exa', name: 'exa',
    description: 'web search and crawling',
    default: true,
    install: {
      'claude-code': { mcp: { type: 'http', url: 'https://mcp.exa.ai/mcp' } },
      'copilot-cli': { mcp: { type: 'http', url: 'https://mcp.exa.ai/mcp' } },
      cursor: { mcp: { type: 'http', url: 'https://mcp.exa.ai/mcp' } },
      'generic-mcp': { mcp: { type: 'http', url: 'https://mcp.exa.ai/mcp' } },
    },
  },
  {
    id: 'playwright', name: 'playwright',
    description: 'browser automation and testing via CLI',
    default: true,
    install: {
      'claude-code': {
        commands: ['npx @playwright/cli install', 'npx @playwright/cli install --skills'],
      },
      'copilot-cli': {
        commands: ['npx @playwright/cli install', 'npx @playwright/cli install --skills'],
      },
      cursor: {
        commands: ['npx @playwright/cli install', 'npx @playwright/cli install --skills'],
      },
    },
  },
  {
    id: 'microsoft-learn', name: 'microsoft-learn',
    description: 'Azure and .NET docs',
    default: false,
    install: {
      'claude-code': { mcp: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } },
      'copilot-cli': { mcp: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } },
      'generic-mcp': { mcp: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } },
    },
  },
];

export function getCompanions(): Companion[] { return [...COMPANIONS]; }
export function getDefaultCompanions(): Companion[] { return COMPANIONS.filter(c => c.default); }
export function filterCompanions(companions: Companion[], exclude: string[]): Companion[] {
  const excludeSet = new Set(exclude);
  return companions.filter(c => !excludeSet.has(c.id));
}
export function getCompanionInstall(companion: Companion, env: Environment): CompanionInstall | undefined {
  return companion.install[env];
}
