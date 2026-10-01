/**
 * NDJSON encoder. It writes one JSON object per line, terminated by `\n`. It
 * writes each frame synchronously and adds no buffer beyond the buffer of the stream.
 */
import type { Writable } from 'node:stream';
import type { Frame } from './frames.js';

/**
 * Encode a single frame as an NDJSON line (JSON followed by `\n`).
 */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame) + '\n';
}

/** Streaming NDJSON encoder over a `Writable`. Each `write()` call writes one frame as one line. */
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
