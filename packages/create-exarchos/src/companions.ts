import type { Companion, CompanionInstall, Environment } from './types.js';

export const COMPANIONS: Companion[] = [
  {
    id: 'axiom', name: 'axiom',
    description: 'backend quality checks (8 dimensions incl. prose quality)',
    default: true,
    install: { 'claude-code': { plugin: 'axiom@lvlup-sw' }, cursor: { skills: 'lvlup-sw/axiom' } },
  },
  {
    id: 'impeccable', name: 'impeccable',
    description: 'frontend design quality (17 skills)',
    default: true,
    install: { 'claude-code': { plugin: 'impeccable@impeccable' }, cursor: { skills: 'pbakaus/impeccable' } },
  },
  {
    id: 'serena', name: 'serena',
    description: 'semantic code analysis',
    default: true,
    install: { 'claude-code': { plugin: 'serena@claude-plugins-official' } },
  },
  {
    id: 'context7', name: 'context7',
    description: 'library documentation',
    default: true,
    install: { 'claude-code': { plugin: 'context7@claude-plugins-official' } },
  },
  {
    id: 'microsoft-learn', name: 'microsoft-learn',
    description: 'Azure and .NET docs',
    default: false,
    install: {
      'claude-code': { mcp: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } },
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
