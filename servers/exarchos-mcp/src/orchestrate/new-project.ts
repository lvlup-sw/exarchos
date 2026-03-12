// ─── New Project Scaffolding Handler ────────────────────────────────────────
//
// Port of scripts/new-project.sh — scaffolds a new project with Claude Code
// configuration: CLAUDE.md from template, .claude/settings.json, .gitignore.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolResult } from '../format.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface NewProjectArgs {
  readonly projectPath?: string;
  readonly language?: 'typescript' | 'csharp';
  readonly minimal?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SETTINGS_JSON = JSON.stringify(
  { permissions: { allow: [] } },
  null,
  2,
);

// ─── Template Resolution ────────────────────────────────────────────────────

function resolveTemplatePath(): string {
  const pluginRoot = process.env.EXARCHOS_PLUGIN_ROOT;
  if (pluginRoot) {
    return join(pluginRoot, 'CLAUDE.md.template');
  }
  // Fallback: relative to this file's location (servers/exarchos-mcp/src/orchestrate/)
  // -> repo root is four levels up
  return join(__dirname, '..', '..', '..', '..', 'CLAUDE.md.template');
}

// ─── Language Customization ─────────────────────────────────────────────────

function applyLanguageCustomizations(content: string, language: string): string {
  let result = content;
  if (language === 'typescript') {
    result = result.replace(/npm run test:coverage/g, 'npm run test -- --coverage');
    result = result.replace(/npm run test:run/g, 'npm run test');
  } else if (language === 'csharp') {
    result = result.replace(/npm run test:run/g, 'dotnet test');
    result = result.replace(/npm run test:coverage/g, 'dotnet test --collect:"XPlat Code Coverage"');
    result = result.replace(/npm run typecheck/g, 'dotnet build');
  }
  return result;
}

// ─── Gitignore Update ───────────────────────────────────────────────────────

function updateGitignore(projectPath: string): boolean {
  const gitignorePath = join(projectPath, '.gitignore');
  const entry = '.claude/settings.local.json';

  // Read existing .gitignore if it exists
  let existing = '';
  if (existsSync(gitignorePath)) {
    try {
      existing = readFileSync(gitignorePath, 'utf-8');
    } catch {
      // If we can't read it, proceed to append
    }
  }

  if (existing.includes('settings.local.json')) {
    return false;
  }

  appendFileSync(gitignorePath, `${entry}\n`);
  return true;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export function handleNewProject(args: NewProjectArgs): ToolResult {
  const projectPath = resolve(args.projectPath ?? '.');
  const language = args.language;
  const minimal = args.minimal ?? false;
  const filesCreated: string[] = [];
  const report: string[] = [];

  // 1. Create project directory if needed
  if (!existsSync(projectPath)) {
    mkdirSync(projectPath, { recursive: true });
    report.push(`Created project directory: ${projectPath}`);
  }

  // 2. Resolve template
  const templatePath = resolveTemplatePath();
  if (!existsSync(templatePath)) {
    return {
      success: false,
      error: {
        code: 'TEMPLATE_NOT_FOUND',
        message: `CLAUDE.md.template not found at ${templatePath}`,
      },
    };
  }

  // 3. Copy CLAUDE.md from template if not exists
  const claudeMdPath = join(projectPath, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    report.push('[skip] CLAUDE.md already exists');
  } else {
    let content = readFileSync(templatePath, 'utf-8');

    // 4. Apply language customizations
    if (language) {
      content = applyLanguageCustomizations(content, language);
    }

    writeFileSync(claudeMdPath, content, 'utf-8');
    filesCreated.push('CLAUDE.md');
    report.push('[created] CLAUDE.md');
  }

  // 5. Create .claude/settings.json unless minimal
  if (!minimal) {
    const claudeDir = join(projectPath, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settingsPath = join(claudeDir, 'settings.json');
    if (existsSync(settingsPath)) {
      report.push('[skip] .claude/settings.json already exists');
    } else {
      writeFileSync(settingsPath, SETTINGS_JSON + '\n', 'utf-8');
      filesCreated.push('.claude/settings.json');
      report.push('[created] .claude/settings.json');
    }

    // 6. Update .gitignore if git repo
    const gitDir = join(projectPath, '.git');
    if (existsSync(gitDir)) {
      if (updateGitignore(projectPath)) {
        report.push('[updated] .gitignore (added settings.local.json)');
      }
    }
  }

  return {
    success: true,
    data: {
      projectPath,
      filesCreated,
      report: report.join('\n'),
    },
  };
}
