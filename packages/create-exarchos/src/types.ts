export type Environment = 'claude-code' | 'cursor' | 'generic-mcp' | 'cli';

export interface McpServerConfig {
  type: string;
  url?: string;
  command?: string;
  args?: string[];
}

export interface CompanionInstall {
  plugin?: string;
  mcp?: McpServerConfig;
  skills?: string;
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
