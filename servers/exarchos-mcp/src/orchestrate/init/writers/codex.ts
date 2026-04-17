/**
 * CodexWriter — stub config writer for Codex runtime.
 *
 * Codex config format is not yet finalized. Returns a stub result
 * with a warning directing the user to re-run init once support lands.
 */

import type { ConfigWriteResult, ConfigWriter } from '../schema.js';

export class CodexWriter implements ConfigWriter {
  readonly runtime = 'codex';

  async write(_projectRoot: string): Promise<ConfigWriteResult> {
    return {
      runtime: this.runtime,
      status: 'stub',
      componentsWritten: [],
      warnings: [
        'Codex config format not yet finalized — run exarchos init again after Codex support is confirmed',
      ],
    };
  }
}
