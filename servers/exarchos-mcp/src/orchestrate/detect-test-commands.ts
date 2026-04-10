// ─── Polyglot Test Command Detection ────────────────────────────────────────
//
// Detects the appropriate test and typecheck commands for a repository based
// on project marker files. Supports Node (package.json), .NET (*.csproj),
// Rust (Cargo.toml), and Python (pyproject.toml). Falls back to null when
// no recognized project type is found.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

export interface TestCommands {
  test: string | null;
  typecheck: string | null;
}

/** Allowlist pattern for test command overrides. Rejects shell metacharacters (;|&$`(){}!<>). */
const SAFE_COMMAND_PATTERN = /^[a-zA-Z0-9_\-\s:.=\/+,@"'\\]+$/;

export function detectTestCommands(repoRoot: string, override?: string): TestCommands {
  if (override) {
    if (!SAFE_COMMAND_PATTERN.test(override)) {
      throw new Error(`Invalid testCommand: contains disallowed characters. Must match ${SAFE_COMMAND_PATTERN}`);
    }
    return { test: override, typecheck: null };
  }

  // Priority order: package.json > *.csproj > Cargo.toml > pyproject.toml
  if (existsSync(path.join(repoRoot, 'package.json'))) {
    return { test: 'npm run test:run', typecheck: 'npm run typecheck' };
  }

  // Check for *.csproj files
  try {
    const entries = readdirSync(repoRoot);
    if (entries.some((f) => f.endsWith('.csproj'))) {
      return { test: 'dotnet test', typecheck: null };
    }
  } catch {
    /* directory unreadable — fall through */
  }

  if (existsSync(path.join(repoRoot, 'Cargo.toml'))) {
    return { test: 'cargo test', typecheck: null };
  }

  if (existsSync(path.join(repoRoot, 'pyproject.toml'))) {
    return { test: 'pytest', typecheck: null };
  }

  return { test: null, typecheck: null };
}
