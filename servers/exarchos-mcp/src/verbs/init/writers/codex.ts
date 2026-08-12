/**
 * CodexWriter — stub config writer for Codex runtime.
 *
 * Codex config format is not yet finalized. Returns a stub result
 * with a warning directing the user to re-run init once support lands.
 */

import type { ConfigWriteResult } from '../schema.js';
import type { RuntimeConfigWriter, WriteOptions } from './writer.js';
import type { WriterDeps } from '../probes.js';

export class CodexWriter implements RuntimeConfigWriter {
  readonly runtime = 'codex';

  async write(_deps: WriterDeps, _options: WriteOptions): Promise<ConfigWriteResult> {
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
