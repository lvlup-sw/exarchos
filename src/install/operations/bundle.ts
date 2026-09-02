/**
 * MCP server bundle copy for the Exarchos installer.
 *
 * Copies a bundled MCP server JavaScript file into the
 * `~/.claude/mcp-servers/` directory so it can be launched
 * by the Claude Code runtime.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Result of installing a bundle file. */
export interface BundleResult {
  /** Absolute path where the bundle was installed. */
  readonly installedPath: string;
  /** Size of the installed file in bytes. */
  readonly sizeBytes: number;
}

/**
 * Copy a bundled MCP server file to the Claude home mcp-servers directory.
 *
 * Ensures the target directory exists, copies the file (overwriting if
 * it already exists), and returns the installed path and file size.
 *
 * @param bundlePath - Absolute path to the source bundle file.
 * @param claudeHome - Absolute path to the `~/.claude/` directory.
 * @returns The installed path and file size.
 * @throws If the source bundle file does not exist.
 */
export function installBundle(bundlePath: string, claudeHome: string): BundleResult {
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Bundle source does not exist: ${bundlePath}`);
  }

  const mcpServersDir = path.join(claudeHome, 'mcp-servers');
  fs.mkdirSync(mcpServersDir, { recursive: true });

  const filename = path.basename(bundlePath);
  const installedPath = path.join(mcpServersDir, filename);
  fs.copyFileSync(bundlePath, installedPath);

  const stats = fs.statSync(installedPath);

  return {
    installedPath,
    sizeBytes: stats.size,
  };
}
