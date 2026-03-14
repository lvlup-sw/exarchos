// ─── New Project Scaffolding Handler ────────────────────────────────────────
//
// Scaffolds a new project with workflow configuration files.
// Supports Claude Code-specific config (.claude/settings.json),
// generic Exarchos config (.exarchos.yml), or auto-detection.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolResult } from '../format.js';
import { isClaudeCodePlugin } from '../utils/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Types ──────────────────────────────────────────────────────────────────

type Platform = 'claude-code' | 'generic' | 'auto';

interface NewProjectArgs {
  readonly projectPath?: string;
  readonly language?: 'typescript' | 'csharp';
  readonly minimal?: boolean;
  readonly platform?: Platform;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SETTINGS_JSON = JSON.stringify(
  { permissions: { allow: [] } },
  null,
  2,
);

const EXARCHOS_YML_TEMPLATE = `# Exarchos workflow configuration
# See https://lvlup-sw.github.io/exarchos/reference/configuration for options

review:
  dimensions:
    D1: blocking
    D2: blocking
    D3: warning
    D4: warning
    D5: warning

tools:
  commit-style: conventional
`;

// ─── Platform Resolution ───────────────────────────────────────────────────

function resolvePlatform(platform: Platform): 'claude-code' | 'generic' {
  if (platform === 'auto') {
    return isClaudeCodePlugin() ? 'claude-code' : 'generic';
  }
  return platform;
}

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

function updateGitignore(projectPath: string): boolean | { error: string } {
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

  try {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  } catch (err) {
    return { error: `Failed to update .gitignore: ${err instanceof Error ? err.message : String(err)}` };
  }
  return true;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export function handleNewProject(args: NewProjectArgs): ToolResult {
  if (args.projectPath !== undefined && (typeof args.projectPath !== 'string' || args.projectPath.trim() === '')) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'projectPath must be a non-empty string',
      },
    };
  }

  const projectPath = resolve(args.projectPath ?? '.');
  const language = args.language;
  const minimal = args.minimal ?? false;
  const resolvedPlatform = resolvePlatform(args.platform ?? 'auto');
  const filesCreated: string[] = [];
  const report: string[] = [];

  // 1. Create project directory if needed
  if (!existsSync(projectPath)) {
    try {
      mkdirSync(projectPath, { recursive: true });
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'MKDIR_FAILED',
          message: `Failed to create project directory ${projectPath}: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
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
    let content: string;
    try {
      content = readFileSync(templatePath, 'utf-8');
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'TEMPLATE_READ_FAILED',
          message: `Failed to read template ${templatePath}: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    // 4. Apply language customizations
    if (language) {
      content = applyLanguageCustomizations(content, language);
    }

    try {
      writeFileSync(claudeMdPath, content, 'utf-8');
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'WRITE_FAILED',
          message: `Failed to write CLAUDE.md at ${claudeMdPath}: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    filesCreated.push('CLAUDE.md');
    report.push('[created] CLAUDE.md');
  }

  // 5. Create platform-specific config unless minimal
  if (!minimal) {
    if (resolvedPlatform === 'claude-code') {
      // Claude Code: create .claude/settings.json and update .gitignore
      const claudeDir = join(projectPath, '.claude');
      try {
        mkdirSync(claudeDir, { recursive: true });
      } catch (err) {
        return {
          success: false,
          error: {
            code: 'MKDIR_FAILED',
            message: `Failed to create .claude directory: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      const settingsPath = join(claudeDir, 'settings.json');
      if (existsSync(settingsPath)) {
        report.push('[skip] .claude/settings.json already exists');
      } else {
        try {
          writeFileSync(settingsPath, SETTINGS_JSON + '\n', 'utf-8');
        } catch (err) {
          return {
            success: false,
            error: {
              code: 'WRITE_FAILED',
              message: `Failed to write settings.json: ${err instanceof Error ? err.message : String(err)}`,
            },
          };
        }
        filesCreated.push('.claude/settings.json');
        report.push('[created] .claude/settings.json');
      }

      // Update .gitignore if git repo
      const gitDir = join(projectPath, '.git');
      if (existsSync(gitDir)) {
        const gitignoreResult = updateGitignore(projectPath);
        if (typeof gitignoreResult === 'object' && 'error' in gitignoreResult) {
          return {
            success: false,
            error: {
              code: 'GITIGNORE_UPDATE_FAILED',
              message: gitignoreResult.error,
            },
          };
        }
        if (gitignoreResult === true) {
          report.push('[updated] .gitignore (added settings.local.json)');
        }
      }
    } else {
      // Generic: create .exarchos.yml
      const ymlPath = join(projectPath, '.exarchos.yml');
      if (existsSync(ymlPath)) {
        report.push('[skip] .exarchos.yml already exists');
      } else {
        try {
          writeFileSync(ymlPath, EXARCHOS_YML_TEMPLATE, 'utf-8');
        } catch (err) {
          return {
            success: false,
            error: {
              code: 'WRITE_FAILED',
              message: `Failed to write .exarchos.yml: ${err instanceof Error ? err.message : String(err)}`,
            },
          };
        }
        filesCreated.push('.exarchos.yml');
        report.push('[created] .exarchos.yml');
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
