/**
 * OpenCodeWriter — stub config writer for OpenCode runtime.
 *
 * OpenCode config format is not yet finalized. Returns a stub result
 * with a warning directing the user to re-run init once support lands.
 */

import type { ConfigWriteResult } from '../schema.js';
import type { RuntimeConfigWriter, WriteOptions } from './writer.js';
import type { WriterDeps } from '../probes.js';

export class OpenCodeWriter implements RuntimeConfigWriter {
  readonly runtime = 'opencode';

  async write(_deps: WriterDeps, _options: WriteOptions): Promise<ConfigWriteResult> {
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
