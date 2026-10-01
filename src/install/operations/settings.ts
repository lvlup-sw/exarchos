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
  readonly env?: Readonly<Record<string, string>>;
  readonly teammateMode?: string;
  readonly hooks?: Readonly<Record<string, unknown[]>>;
}

/**
 * Generate settings.json from wizard selections. It combines the permission
 * list, the selected model, the enabled plugins, fixed env values and
 * `teammateMode`. It adds `hooks` only when the map is not empty.
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
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '90',
    },
    teammateMode: 'auto',
  };

  if (hooks && Object.keys(hooks).length > 0) {
    return { ...settings, hooks };
  }

  return settings;
}

/**
 * Generate the permission allow-list: the native Claude Code tools, the MCP
 * wildcard, and Bash commands grouped by ecosystem and purpose.
 *
 * @returns The permission strings for settings.json.
 */
export function generatePermissions(): string[] {
  return [
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

    'mcp__*',

    'Bash(gt:*)',
    'Bash(gh:*)',
    'Bash(git:*)',

    'Bash(npm:*)',
    'Bash(npx:*)',
    'Bash(yarn:*)',
    'Bash(pnpm:*)',
    'Bash(bun:*)',
    'Bash(node:*)',

    'Bash(dotnet:*)',
    'Bash(nuget:*)',
    'Bash(msbuild:*)',

    'Bash(cargo:*)',
    'Bash(rustc:*)',
    'Bash(rustup:*)',

    'Bash(go:*)',

    'Bash(python:*)',
    'Bash(python3:*)',
    'Bash(pip:*)',
    'Bash(pip3:*)',
    'Bash(poetry:*)',
    'Bash(uv:*)',

    'Bash(ruby:*)',
    'Bash(gem:*)',
    'Bash(bundle:*)',

    'Bash(java:*)',
    'Bash(javac:*)',
    'Bash(mvn:*)',
    'Bash(gradle:*)',

    'Bash(docker:*)',
    'Bash(docker-compose:*)',
    'Bash(podman:*)',
    'Bash(kubectl:*)',
    'Bash(helm:*)',

    'Bash(terraform:*)',
    'Bash(pulumi:*)',
    'Bash(aws:*)',
    'Bash(az:*)',
    'Bash(gcloud:*)',

    'Bash(make:*)',
    'Bash(cmake:*)',
    'Bash(ninja:*)',

    'Bash(jest:*)',
    'Bash(vitest:*)',
    'Bash(pytest:*)',
    'Bash(mocha:*)',

    'Bash(eslint:*)',
    'Bash(prettier:*)',
    'Bash(tsc:*)',

    'Bash(curl:*)',
    'Bash(wget:*)',
    'Bash(ssh:*)',
    'Bash(scp:*)',
    'Bash(rsync:*)',

    'Bash(ls:*)',
    'Bash(cat:*)',
    'Bash(head:*)',
    'Bash(tail:*)',

    'Bash(find:*)',
    'Bash(grep:*)',
    'Bash(rg:*)',
    'Bash(fd:*)',
    'Bash(ag:*)',
    'Bash(ack:*)',

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

    'Bash(mkdir:*)',
    'Bash(rm:*)',
    'Bash(rmdir:*)',
    'Bash(cp:*)',
    'Bash(mv:*)',
    'Bash(touch:*)',
    'Bash(chmod:*)',
    'Bash(ln:*)',

    'Bash(tar:*)',
    'Bash(zip:*)',
    'Bash(unzip:*)',
    'Bash(gzip:*)',
    'Bash(gunzip:*)',

    'Bash(diff:*)',
    'Bash(patch:*)',

    'Bash(echo:*)',
    'Bash(printf:*)',
    'Bash(date:*)',
    'Bash(env:*)',
    'Bash(export:*)',
    'Bash(which:*)',
    'Bash(whereis:*)',
    'Bash(type:*)',

    'Bash(pwd:*)',
    'Bash(cd:*)',
    'Bash(pushd:*)',
    'Bash(popd:*)',
    'Bash(realpath:*)',
    'Bash(basename:*)',
    'Bash(dirname:*)',

    'Bash(ps:*)',
    'Bash(kill:*)',
    'Bash(pkill:*)',
    'Bash(pgrep:*)',
    'Bash(time:*)',
    'Bash(timeout:*)',
    'Bash(watch:*)',

    'Bash(du:*)',
    'Bash(df:*)',
    'Bash(stat:*)',
    'Bash(file:*)',
    'Bash(tree:*)',

    'Bash(ping:*)',
    'Bash(nc:*)',
    'Bash(netstat:*)',
    'Bash(ss:*)',
    'Bash(lsof:*)',

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
