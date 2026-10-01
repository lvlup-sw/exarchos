/**
 * Interactive wizard flow for the installer. Its prompts produce the
 * {@link WizardResult} that drives the installation.
 */

import type { Manifest } from '../manifest/types.js';
import type { ExarchosConfig, WizardSelections } from '../operations/config.js';
import type { PromptAdapter, MultiselectOption } from './prompts.js';
import { getDefaultSelections, getRequiredComponents } from '../manifest/loader.js';
import { readConfig } from '../operations/config.js';
import { formatHeader } from './display.js';

/** Result produced by the wizard flow. */
export interface WizardResult {
  /** Installation mode: standard (copy) or dev (symlink). */
  readonly mode: 'standard' | 'dev';
  /** Component selections for installation. */
  readonly selections: WizardSelections;
}

/**
 * Run the interactive wizard. It prompts for the mode, the optional MCP
 * servers, the optional plugins and the rule sets. Then it shows a summary and
 * asks for confirmation. The result always includes the required components.
 * When `existingConfig` is set, its selections are the defaults.
 */
export async function runWizard(
  manifest: Manifest,
  prompts: PromptAdapter,
  existingConfig?: ExarchosConfig,
): Promise<WizardResult> {
  const required = getRequiredComponents(manifest);
  const defaults = existingConfig
    ? existingConfig.selections
    : getDefaultSelections(manifest);

  console.log('');
  console.log(formatHeader('Exarchos', manifest.version));
  if (existingConfig) {
    console.log(`  Updating existing installation (${existingConfig.mode} mode)`);
  }
  console.log('');

  const mode = await prompts.select<'standard' | 'dev'>('Installation mode:', [
    { label: 'Standard', value: 'standard', description: 'Copy files to ~/.claude/ — recommended for most users' },
    { label: 'Dev', value: 'dev', description: 'Symlink to repo for live editing — for Exarchos contributors' },
  ]);

  const requiredServerNames = manifest.components.mcpServers
    .filter((s) => s.required)
    .map((s) => s.name);
  console.log(`\n  Required: ${requiredServerNames.join(', ')} (always installed)`);

  const optionalServers = manifest.components.mcpServers.filter((s) => !s.required);
  let selectedOptionalServers: string[] = [];
  if (optionalServers.length > 0) {
    const serverOptions: MultiselectOption<string>[] = optionalServers.map((s) => ({
      label: s.name,
      value: s.id,
      description: s.description,
      selected: defaults.mcpServers.includes(s.id),
    }));
    selectedOptionalServers = await prompts.multiselect('Additional MCP servers:', serverOptions);
  }

  const requiredPluginNames = manifest.components.plugins
    .filter((p) => p.required)
    .map((p) => p.name);
  if (requiredPluginNames.length > 0) {
    console.log(`\n  Required: ${requiredPluginNames.join(', ')} (always installed)`);
  }

  const optionalPlugins = manifest.components.plugins.filter((p) => !p.required);
  let selectedOptionalPlugins: string[] = [];
  if (optionalPlugins.length > 0) {
    const pluginOptions: MultiselectOption<string>[] = optionalPlugins.map((p) => ({
      label: p.name,
      value: p.id,
      description: p.description,
      selected: defaults.plugins.includes(p.id),
    }));
    selectedOptionalPlugins = await prompts.multiselect('Claude plugins:', pluginOptions);
  }

  console.log('\n  Rule sets configure coding standards and workflow behavior.');
  const ruleSetOptions: MultiselectOption<string>[] = manifest.components.ruleSets.map((r) => ({
    label: r.name,
    value: r.id,
    description: r.description,
    selected: defaults.ruleSets.includes(r.id),
  }));
  const selectedRuleSets = await prompts.multiselect('Rule sets:', ruleSetOptions);

  const allServers = [...requiredServerNames, ...optionalServers.filter((s) => selectedOptionalServers.includes(s.id)).map((s) => s.name)];
  const allPlugins = [...requiredPluginNames, ...optionalPlugins.filter((p) => selectedOptionalPlugins.includes(p.id)).map((p) => p.name)];
  const selectedRuleNames = manifest.components.ruleSets.filter((r) => selectedRuleSets.includes(r.id)).map((r) => r.name);

  console.log('\n  Summary:');
  console.log(`    Mode:        ${mode}`);
  console.log(`    MCP servers: ${allServers.join(', ')}`);
  console.log(`    Plugins:     ${allPlugins.length > 0 ? allPlugins.join(', ') : '(none)'}`);
  console.log(`    Rule sets:   ${selectedRuleNames.length > 0 ? selectedRuleNames.join(', ') : '(none)'}`);
  console.log('');

  await prompts.confirm('Proceed with installation?', true);

  const mcpServers = [
    ...required.servers,
    ...selectedOptionalServers.filter((id) => !required.servers.includes(id)),
  ];

  const plugins = [
    ...required.plugins,
    ...selectedOptionalPlugins.filter((id) => !required.plugins.includes(id)),
  ];

  return {
    mode,
    selections: {
      mcpServers,
      plugins,
      ruleSets: selectedRuleSets,
      model: defaults.model,
    },
  };
}

/** Options for non-interactive installation. */
interface NonInteractiveOptions {
  /** Use manifest defaults (or existing config if provided). */
  readonly useDefaults?: boolean;
  /** Path to a config file to read selections from. */
  readonly configPath?: string;
  /** Existing config to use as defaults when useDefaults is true. */
  readonly existingConfig?: ExarchosConfig;
}

/**
 * Return the wizard result without prompts. The selections come from the file
 * at `configPath`, else from `existingConfig` when `useDefaults` is set, else
 * from the manifest defaults. The result always includes the required
 * components.
 *
 * @throws When `configPath` is set but the file cannot be read.
 */
export function runNonInteractive(
  manifest: Manifest,
  options: NonInteractiveOptions,
): WizardResult {
  const required = getRequiredComponents(manifest);

  let baseSelections: WizardSelections;
  let baseMode: 'standard' | 'dev';

  if (options.configPath) {
    const config = readConfig(options.configPath);
    if (!config) {
      throw new Error(`Config file not found: ${options.configPath}`);
    }
    baseSelections = config.selections;
    baseMode = config.mode;
  } else if (options.useDefaults && options.existingConfig) {
    baseSelections = options.existingConfig.selections;
    baseMode = options.existingConfig.mode;
  } else {
    baseSelections = getDefaultSelections(manifest);
    baseMode = manifest.defaults.mode;
  }

  const mcpServers = [
    ...required.servers,
    ...baseSelections.mcpServers.filter((id) => !required.servers.includes(id)),
  ];

  const plugins = [
    ...required.plugins,
    ...baseSelections.plugins.filter((id) => !required.plugins.includes(id)),
  ];

  return {
    mode: baseMode,
    selections: {
      mcpServers,
      plugins,
      ruleSets: [...baseSelections.ruleSets],
      model: baseSelections.model,
    },
  };
}
