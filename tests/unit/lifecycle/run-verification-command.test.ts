/**
 * The default writers of a verification verb. Each one writes its text to its own stream and ends it with one newline.
 * The cases replace `write` of each stream with a recorder, so no text reaches the terminal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultStderr, defaultStdout } from '../../../src/lifecycle/run-verification-command.js';

afterEach(() => { vi.restoreAllMocks(); });

/** Each text that `write` of `stream` gets while `run` runs. */
function written(stream: NodeJS.WriteStream, run: () => void): unknown[] {
  const write = vi.spyOn(stream, 'write').mockImplementation(() => true);
  run();
  return write.mock.calls.map(([text]) => text);
}

describe('the default writers of a verification verb', () => {
  /** A text with no newline gets one. A text that ends in a newline gets no second one. */
  it('DefaultStdout_EndsEachTextWithOneNewline', () => {
    expect(written(process.stdout, () => { defaultStdout('ran'); defaultStdout('done\n'); })).toEqual(['ran\n', 'done\n']);
  });

  /** The error writer keeps the same newline rule, and it writes to stderr only. */
  it('DefaultStderr_EndsEachTextWithOneNewlineOnStderr', () => {
    const outputs: unknown[] = [];
    const errors = written(process.stderr, () => {
      outputs.push(...written(process.stdout, () => { defaultStderr('failed'); defaultStderr('stopped\n'); }));
    });
    expect(errors).toEqual(['failed\n', 'stopped\n']);
    expect(outputs).toEqual([]);
  });
});
