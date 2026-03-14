import type { ResolvedProjectConfig } from '../config/resolve.js';
import { DEFAULTS } from '../config/resolve.js';

export function getToolsConfig(config?: ResolvedProjectConfig): ResolvedProjectConfig['tools'] {
  return config?.tools ?? DEFAULTS.tools;
}
