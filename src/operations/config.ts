/**
 * ExarchosConfig types and persistence for the installer.
 *
 * The config file (`~/.claude/exarchos.json`) records what was installed,
 * which selections the user made, and content hashes for drift detection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * User selections from the installation wizard.
 *
 * Captures which optional components the user chose to install
 * and their preferred model.
 */
export interface WizardSelections {
  /** IDs of selected MCP servers (excludes required servers). */
  readonly mcpServers: readonly string[];
  /** IDs of selected plugins. */
  readonly plugins: readonly string[];
  /** IDs of selected rule sets. */
  readonly ruleSets: readonly string[];
  /** Selected Claude model identifier. */
  readonly model: string;
}

/**
 * Persisted installer configuration.
 *
 * Written to `~/.claude/exarchos.json` after each install or update.
 * Used for drift detection, upgrade diffing, and uninstall tracking.
 */
export interface ExarchosConfig {
  /** Config schema version (semver). */
  readonly version: string;
  /** ISO-8601 timestamp of the last install/update. */
  readonly installedAt: string;
  /** Installation mode: standard (copy) or dev (symlink). */
  readonly mode: 'standard' | 'dev';
  /** Absolute path to the Exarchos repo (only set in dev mode). */
  readonly repoPath?: string;
  /** The user's component selections. */
  readonly selections: WizardSelections;
  /** Content hashes for drift detection (relative path -> SHA-256 hex). */
  readonly hashes: Record<string, string>;
}

/**
 * Read the Exarchos config file from disk.
 *
 * @param filePath - Absolute path to the config JSON file.
 * @returns The parsed config, or `null` if the file does not exist.
 * @throws If the file exists but contains invalid JSON.
 */
export function readConfig(filePath: string): ExarchosConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  try {
    return JSON.parse(raw) as ExarchosConfig;
  } catch {
    throw new Error(`Failed to parse config JSON at ${filePath}`);
  }
}

/**
 * Write the Exarchos config file to disk.
 *
 * Creates parent directories if they do not exist.
 * Output is pretty-printed with 2-space indentation.
 *
 * @param filePath - Absolute path to the config JSON file.
 * @param config - The config to persist.
 */
export function writeConfig(filePath: string, config: ExarchosConfig): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
