export type Environment = 'claude-code' | 'copilot-cli' | 'cursor' | 'generic-mcp' | 'cli';

export interface McpServerConfig {
  type: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CompanionInstall {
  plugin?: string;
  mcp?: McpServerConfig;
  skills?: string;
  /** Shell command to run (e.g. npx @playwright/cli install --skills). Runs after plugin/mcp/skills. */
  commands?: string[];
}

export interface Companion {
  id: string;
  name: string;
  description: string;
  default: boolean;
  install: Partial<Record<Environment, CompanionInstall>>;
}

export interface InstallResult {
  success: boolean;
  name: string;
  error?: string;
  skipped?: boolean;
}

export interface CliArgs {
  interactive: boolean;
  env?: Environment;
  companions: {
    exclude: string[];
  };
}
