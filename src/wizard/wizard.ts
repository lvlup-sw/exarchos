/**
 * Interactive wizard flow for the Exarchos installer.
 *
 * Guides the user through component selection via a series of prompts,
 * producing a {@link WizardResult} that drives installation.
 */

import type { Manifest } from '../manifest/types.js';
import type { ExarchosConfig, WizardSelections } from '../operations/config.js';
import type { PromptAdapter, MultiselectOption } from './prompts.js';
import { getDefaultSelections, getRequiredComponents } from '../manifest/loader.js';
import { readConfig } from '../operations/config.js';

/** Result produced by the wizard flow. */
export interface WizardResult {
  /** Installation mode: standard (copy) or dev (symlink). */
  readonly mode: 'standard' | 'dev';
  /** Component selections for installation. */
  readonly selections: WizardSelections;
}

/**
 * Run the interactive wizard flow.
 *
 * Presents a series of prompts to the user for mode selection,
 * component selection, and model choice. Required components are
 * always included in the result regardless of user selection.
 *
 * @param manifest - The validated installation manifest.
 * @param prompts - The prompt adapter to use for user interaction.
 * @param existingConfig - Optional existing config to use as defaults.
 * @returns The wizard result with mode and selections.
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

  // Step 1: Mode selection
  const mode = await prompts.select<'standard' | 'dev'>('Installation mode:', [
    { label: 'Standard', value: 'standard', description: 'Copy files to ~/.claude/' },
    { label: 'Dev', value: 'dev', description: 'Symlink files for development' },
  ]);

  // Step 2: MCP Servers (optional only — required are always included)
  const optionalServers = manifest.components.mcpServers.filter((s) => !s.required);
  const serverOptions: MultiselectOption<string>[] = optionalServers.map((s) => ({
    label: s.name,
    value: s.id,
    description: s.description,
    selected: defaults.mcpServers.includes(s.id),
  }));
  const selectedOptionalServers = await prompts.multiselect('MCP servers:', serverOptions);

  // Step 3: Plugins (optional only — required are always included)
  const optionalPlugins = manifest.components.plugins.filter((p) => !p.required);
  const pluginOptions: MultiselectOption<string>[] = optionalPlugins.map((p) => ({
    label: p.name,
    value: p.id,
    description: p.description,
    selected: defaults.plugins.includes(p.id),
  }));
  const selectedOptionalPlugins = await prompts.multiselect('Plugins:', pluginOptions);

  // Step 4: Rule sets
  const ruleSetOptions: MultiselectOption<string>[] = manifest.components.ruleSets.map((r) => ({
    label: r.name,
    value: r.id,
    description: r.description,
    selected: defaults.ruleSets.includes(r.id),
  }));
  const selectedRuleSets = await prompts.multiselect('Rule sets:', ruleSetOptions);

  // Step 5: Model
  const selectedModel = await prompts.select('Model:', [
    { label: 'Claude Opus 4.6', value: 'claude-opus-4-6' },
    { label: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
  ]);

  // Step 6: Confirmation
  await prompts.confirm('Proceed with installation?', true);

  // Merge required components with user selections
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
      model: selectedModel,
    },
  };
}

// ─── Non-interactive mode ─────────────────────────────────────────────────────

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
 * Run the installer in non-interactive mode.
 *
 * Determines selections without user prompts, using either manifest defaults,
 * a previous config, or a config file.
 *
 * @param manifest - The validated installation manifest.
 * @param options - Non-interactive mode options.
 * @returns The wizard result with mode and selections.
 * @throws If configPath is provided but the file cannot be read.
 */
export function runNonInteractive(
  manifest: Manifest,
  options: NonInteractiveOptions,
): WizardResult {
  const required = getRequiredComponents(manifest);

  let baseSelections: WizardSelections;
  let baseMode: 'standard' | 'dev';

  if (options.configPath) {
    // Read config from file
    const config = readConfig(options.configPath);
    if (!config) {
      throw new Error(`Config file not found: ${options.configPath}`);
    }
    baseSelections = config.selections;
    baseMode = config.mode;
  } else if (options.useDefaults && options.existingConfig) {
    // Use existing config's selections
    baseSelections = options.existingConfig.selections;
    baseMode = options.existingConfig.mode;
  } else {
    // Use manifest defaults
    baseSelections = getDefaultSelections(manifest);
    baseMode = manifest.defaults.mode;
  }

  // Ensure required components are always included
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
