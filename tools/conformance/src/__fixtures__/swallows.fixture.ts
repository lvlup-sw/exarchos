/**
 * TEST FIXTURE — NOT a shipped delivery path.
 *
 * A deliberately-broken stand-in for a required-delivery module: it swallows a
 * transport failure with an empty `catch`. `delivery-safety.test.ts` audits this
 * file to prove {@link ../delivery-safety.js} FAILS on a planted silent swallow.
 * It performs no real effect (no fs/process/network primitives).
 */

export async function deliverButSwallow(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch {
    // planted silent swallow — this is the violation the check must catch
  }
}
