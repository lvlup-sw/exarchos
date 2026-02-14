/**
 * Settings.json generation for the Exarchos installer.
 *
 * Generates the `settings.json` file that configures Claude Code's
 * permissions, model, and enabled plugins based on wizard selections.
 */

import type { WizardSelections } from './config.js';

/** The settings.json structure for Claude Code. */
export interface Settings {
  readonly permissions: { readonly allow: readonly string[] };
  readonly model: string;
  readonly enabledPlugins: Readonly<Record<string, boolean>>;
  readonly hooks?: Readonly<Record<string, unknown[]>>;
}

/**
 * Generate a complete settings.json from wizard selections.
 *
 * Combines the comprehensive permission list, selected model,
 * and enabled plugin map into a single settings object. Optionally
 * includes Claude Code hook definitions when provided.
 *
 * @param selections - The user's wizard selections.
 * @param hooks - Optional hook definitions keyed by event name.
 * @returns The settings.json content.
 */
export function generateSettings(
  selections: WizardSelections,
  hooks?: Record<string, unknown[]>,
): Settings {
  const enabledPlugins: Record<string, boolean> = {};
  for (const pluginId of selections.plugins) {
    enabledPlugins[pluginId] = true;
  }

  const settings: Settings = {
    permissions: { allow: generatePermissions() },
    model: selections.model,
    enabledPlugins,
  };

  if (hooks && Object.keys(hooks).length > 0) {
    return { ...settings, hooks };
  }

  return settings;
}

/**
 * Generate the comprehensive permission allow-list.
 *
 * Returns a hardcoded list of all tool and bash command permissions
 * needed for full Exarchos functionality.
 *
 * @returns The permission strings for settings.json.
 */
export function generatePermissions(): string[] {
  return [
    // Claude Code native tools
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'NotebookEdit',
    'Task',
    'LSP',
    'WebSearch',
    'WebFetch',

    // MCP wildcard
    'mcp__*',

    // Version control and stacking
    'Bash(gt:*)',
    'Bash(gh:*)',
    'Bash(git:*)',

    // Package managers
    'Bash(npm:*)',
    'Bash(npx:*)',
    'Bash(yarn:*)',
    'Bash(pnpm:*)',
    'Bash(bun:*)',
    'Bash(node:*)',

    // .NET ecosystem
    'Bash(dotnet:*)',
    'Bash(nuget:*)',
    'Bash(msbuild:*)',

    // Rust
    'Bash(cargo:*)',
    'Bash(rustc:*)',
    'Bash(rustup:*)',

    // Go
    'Bash(go:*)',

    // Python
    'Bash(python:*)',
    'Bash(python3:*)',
    'Bash(pip:*)',
    'Bash(pip3:*)',
    'Bash(poetry:*)',
    'Bash(uv:*)',

    // Ruby
    'Bash(ruby:*)',
    'Bash(gem:*)',
    'Bash(bundle:*)',

    // Java/JVM
    'Bash(java:*)',
    'Bash(javac:*)',
    'Bash(mvn:*)',
    'Bash(gradle:*)',

    // Containers and orchestration
    'Bash(docker:*)',
    'Bash(docker-compose:*)',
    'Bash(podman:*)',
    'Bash(kubectl:*)',
    'Bash(helm:*)',

    // Infrastructure
    'Bash(terraform:*)',
    'Bash(pulumi:*)',
    'Bash(aws:*)',
    'Bash(az:*)',
    'Bash(gcloud:*)',

    // Build systems
    'Bash(make:*)',
    'Bash(cmake:*)',
    'Bash(ninja:*)',

    // Testing
    'Bash(jest:*)',
    'Bash(vitest:*)',
    'Bash(pytest:*)',
    'Bash(mocha:*)',

    // Linting and formatting
    'Bash(eslint:*)',
    'Bash(prettier:*)',
    'Bash(tsc:*)',

    // Network
    'Bash(curl:*)',
    'Bash(wget:*)',
    'Bash(ssh:*)',
    'Bash(scp:*)',
    'Bash(rsync:*)',

    // File reading
    'Bash(ls:*)',
    'Bash(cat:*)',
    'Bash(head:*)',
    'Bash(tail:*)',

    // Search
    'Bash(find:*)',
    'Bash(grep:*)',
    'Bash(rg:*)',
    'Bash(fd:*)',
    'Bash(ag:*)',
    'Bash(ack:*)',

    // Text processing
    'Bash(sed:*)',
    'Bash(awk:*)',
    'Bash(sort:*)',
    'Bash(uniq:*)',
    'Bash(wc:*)',
    'Bash(cut:*)',
    'Bash(tr:*)',
    'Bash(tee:*)',
    'Bash(xargs:*)',
    'Bash(jq:*)',
    'Bash(yq:*)',

    // File operations
    'Bash(mkdir:*)',
    'Bash(rm:*)',
    'Bash(rmdir:*)',
    'Bash(cp:*)',
    'Bash(mv:*)',
    'Bash(touch:*)',
    'Bash(chmod:*)',
    'Bash(ln:*)',

    // Archives
    'Bash(tar:*)',
    'Bash(zip:*)',
    'Bash(unzip:*)',
    'Bash(gzip:*)',
    'Bash(gunzip:*)',

    // Diff and patch
    'Bash(diff:*)',
    'Bash(patch:*)',

    // Output and environment
    'Bash(echo:*)',
    'Bash(printf:*)',
    'Bash(date:*)',
    'Bash(env:*)',
    'Bash(export:*)',
    'Bash(which:*)',
    'Bash(whereis:*)',
    'Bash(type:*)',

    // Navigation
    'Bash(pwd:*)',
    'Bash(cd:*)',
    'Bash(pushd:*)',
    'Bash(popd:*)',
    'Bash(realpath:*)',
    'Bash(basename:*)',
    'Bash(dirname:*)',

    // Process management
    'Bash(ps:*)',
    'Bash(kill:*)',
    'Bash(pkill:*)',
    'Bash(pgrep:*)',
    'Bash(time:*)',
    'Bash(timeout:*)',
    'Bash(watch:*)',

    // Disk and file info
    'Bash(du:*)',
    'Bash(df:*)',
    'Bash(stat:*)',
    'Bash(file:*)',
    'Bash(tree:*)',

    // Network diagnostics
    'Bash(ping:*)',
    'Bash(nc:*)',
    'Bash(netstat:*)',
    'Bash(ss:*)',
    'Bash(lsof:*)',

    // Shell builtins
    'Bash(source:*)',
    'Bash(.:*)',
    'Bash(test:*)',
    'Bash([:*)',
    'Bash([[:*)',
    'Bash(true:*)',
    'Bash(false:*)',
    'Bash(exit:*)',
    'Bash(return:*)',
    'Bash(read:*)',
    'Bash(set:*)',
    'Bash(unset:*)',
    'Bash(shift:*)',
    'Bash(getopts:*)',
    'Bash(declare:*)',
    'Bash(local:*)',
    'Bash(eval:*)',
  ];
}
