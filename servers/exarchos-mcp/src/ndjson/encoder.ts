import type { Writable } from 'node:stream';
import type { Frame } from './frames.js';

/**
 * NDJSON encoder (DR-9, T027).
 *
 * Emits one JSON object per line, terminated by `\n`. Each frame is written
 * synchronously to the underlying stream; no internal buffering beyond what
 * the stream itself provides.
 */

/**
 * Encode a single frame as an NDJSON line (JSON followed by `\n`).
 */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame) + '\n';
}

/**
 * Streaming NDJSON encoder. Wraps a `Writable` and writes one frame per
 * `write()` call; each frame is flushed as a standalone line.
 */
export class NdjsonEncoder {
  private readonly sink: Writable;

  constructor(sink: Writable) {
    this.sink = sink;
  }

  /**
   * Write a single frame as one NDJSON line. Returns the writable's
   * backpressure signal from `sink.write`.
   */
  write(frame: Frame): boolean {
    return this.sink.write(encodeFrame(frame));
  }

  /**
   * Signal end-of-stream to the underlying writable.
   */
  end(): void {
    this.sink.end();
  }
}
