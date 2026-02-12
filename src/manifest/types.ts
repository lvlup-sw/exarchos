/**
 * Manifest type definitions for the Exarchos installer.
 *
 * The manifest declares all installable components, their metadata,
 * and default selections. It is the single source of truth for what
 * the installer can provision.
 */

/** Top-level manifest describing all installable components. */
export interface Manifest {
  /** Manifest schema version (semver). */
  readonly version: string;
  /** Component groups available for installation. */
  readonly components: ManifestComponents;
  /** Default configuration values. */
  readonly defaults: ManifestDefaults;
}

/** Grouped component lists within a manifest. */
export interface ManifestComponents {
  /** Core file/directory symlinks (always installed). */
  readonly core: readonly CoreComponent[];
  /** MCP server registrations. */
  readonly mcpServers: readonly McpServerComponent[];
  /** Claude Code plugin registrations. */
  readonly plugins: readonly PluginComponent[];
  /** Grouped rule files selectable as sets. */
  readonly ruleSets: readonly RuleSetComponent[];
}

/** Default configuration values applied when no overrides are given. */
export interface ManifestDefaults {
  /** Default Claude model identifier. */
  readonly model: string;
  /** Installation mode. */
  readonly mode: 'standard' | 'dev';
}

/** A core file or directory that is always symlinked during install. */
export interface CoreComponent {
  /** Unique identifier for this component. */
  readonly id: string;
  /** Relative path within the Exarchos repo (source of symlink). */
  readonly source: string;
  /** Relative path within `~/.claude/` (target of symlink). */
  readonly target: string;
  /** Whether this is a single file or an entire directory. */
  readonly type: 'directory' | 'file';
}

/** An MCP server that can be registered in `~/.claude.json`. */
export interface McpServerComponent {
  /** Unique identifier for this server. */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Short description of the server's purpose. */
  readonly description: string;
  /** Whether this server must always be installed. */
  readonly required: boolean;
  /** How the server is provisioned. */
  readonly type: 'bundled' | 'external' | 'remote';
  /** Relative path to bundled server (type = 'bundled'). */
  readonly bundlePath?: string;
  /** Executable command to launch the server (type = 'external'). */
  readonly command?: string;
  /** Arguments passed to `command` (type = 'external'). */
  readonly args?: readonly string[];
  /** Shell command that must succeed before installation (type = 'external'). */
  readonly prerequisite?: string;
  /** Remote server URL (type = 'remote'). */
  readonly url?: string;
}

/** A Claude Code plugin that can be enabled during install. */
export interface PluginComponent {
  /** Unique identifier for this plugin. */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Short description of the plugin's purpose. */
  readonly description: string;
  /** Whether this plugin must always be installed. */
  readonly required: boolean;
  /** Whether this plugin is selected by default in the wizard. */
  readonly default: boolean;
}

/** A named group of rule files that can be selected as a unit. */
export interface RuleSetComponent {
  /** Unique identifier for this rule set. */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Short description of the rule set's purpose. */
  readonly description: string;
  /** Rule file names within the `rules/` directory. */
  readonly files: readonly string[];
  /** Whether this rule set is selected by default in the wizard. */
  readonly default: boolean;
}
