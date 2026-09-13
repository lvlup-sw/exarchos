// ─── One flight per operation key, within this process ──────────────────────
//
// A claim-keyed handler reads the operation claim BEFORE it does any work, so
// a replay is answered from the durable row instead of redoing the effect. Two
// concurrent calls with the same key would both read an empty claim and both
// do the work; the loser would then be handed the winner's receipt with its own
// effect already performed. Serializing per key closes that window inside one
// process: the second call waits, and its pre-flight finds the first call's
// claim. A second PROCESS racing the same key is still serialized only at the
// commit.
//
// Shared rather than private to one verb because every claim-keyed verb has the
// same window, and a second hand-written copy is where it would reopen.

const operationTails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier flight for `operationKey` in this process has
 * settled. Mirrors the appender's per-stream promise-chain mutex. Not
 * re-entrant: a flight that awaited itself for the same key would deadlock.
 */
export async function runExclusivePerOperation<T>(
  operationKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = operationTails.get(operationKey) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  operationTails.set(operationKey, next);
  try {
    await prior;
    return await fn();
  } finally {
    release();
    if (operationTails.get(operationKey) === next) {
      operationTails.delete(operationKey);
    }
  }
}
