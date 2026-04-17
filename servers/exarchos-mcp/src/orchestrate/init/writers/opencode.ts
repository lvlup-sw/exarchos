/**
 * OpenCodeWriter — stub config writer for OpenCode runtime.
 *
 * OpenCode config format is not yet finalized. Returns a stub result
 * with a warning directing the user to re-run init once support lands.
 */

import type { ConfigWriteResult, ConfigWriter } from '../schema.js';

export class OpenCodeWriter implements ConfigWriter {
  readonly runtime = 'opencode';

  async write(_projectRoot: string): Promise<ConfigWriteResult> {
    return {
      runtime: this.runtime,
      status: 'stub',
      componentsWritten: [],
      warnings: [
        'OpenCode config format not yet finalized — run exarchos init again after OpenCode support is confirmed',
      ],
    };
  }
}
