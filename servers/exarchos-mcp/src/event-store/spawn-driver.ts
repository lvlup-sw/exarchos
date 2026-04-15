// ─── CLI-Equivalent Append Driver (test support) ────────────────────────────
//
// Minimal Node entry point used by `cli-concurrency.test.ts` to exercise the
// EventStore append path from a real child process. Excluded from the vitest
// include glob (not a `.test.ts`) but shipped alongside the test so it moves
// with the suite under refactors.
//
// Invocation:
//   tsx spawn-driver.ts --state-dir <dir> --stream <id> --index <n>
//
// Behaviour: constructs an EventStore against the given state dir, initializes
// it (which may enter sidecar mode if another process holds the PID lock),
// and appends a single `task.completed` event whose idempotency key is
// `concurrent-<index>`. Exits 0 on success, non-zero on error.

import { EventStore } from './store.js';
import { buildValidatedEvent } from './event-factory.js';

interface DriverArgs {
  readonly stateDir: string;
  readonly stream: string;
  readonly index: number;
}

function parseArgs(argv: readonly string[]): DriverArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--')) {
      const name = key.slice(2);
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for flag --${name}`);
      }
      map.set(name, value);
      i++;
    }
  }
  const stateDir = map.get('state-dir');
  const stream = map.get('stream');
  const indexRaw = map.get('index');
  if (!stateDir || !stream || indexRaw === undefined) {
    throw new Error('Usage: spawn-driver.ts --state-dir <dir> --stream <id> --index <n>');
  }
  const index = Number.parseInt(indexRaw, 10);
  if (!Number.isFinite(index)) {
    throw new Error(`--index must be a number, got ${indexRaw}`);
  }
  return { stateDir, stream, index };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const store = new EventStore(args.stateDir);
  // Wait for the PID lock (CLI semantics) rather than entering sidecar mode,
  // so concurrent invocations serialize onto the main JSONL (DR-5).
  await store.initialize({ waitForLock: true });

  const event = buildValidatedEvent(args.stream, 1, {
    type: 'task.completed',
    data: { taskId: `t-${args.index}`, verified: false },
  });

  const ack = await store.appendValidated(args.stream, event, {
    idempotencyKey: `concurrent-${args.index}`,
  });

  process.stdout.write(JSON.stringify({ sequence: ack.sequence, index: args.index }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[driver] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
