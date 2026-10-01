// Runs one flight per operation key at a time, within this process.
// A claim-keyed handler reads the operation claim before it does any work.
// Two concurrent calls with the same key can both read an empty claim and both do the work.
// Per-key serialization closes that window in one process: the second call waits and then finds the claim.
// Two processes that race on the same key serialize only at the commit.
// The module is shared, not part of one verb, because each claim-keyed verb has the same window.

const operationTails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier flight for `operationKey` in this process settles.
 * It is not re-entrant: a flight that awaits a flight for its own key deadlocks.
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
