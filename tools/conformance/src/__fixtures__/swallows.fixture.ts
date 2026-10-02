/**
 * Test fixture, not a shipped delivery path.
 *
 * This stand-in for a required-delivery module swallows a transport failure with
 * an empty `catch`. `delivery-safety.test.ts` audits this file to prove that
 * {@link ../delivery-safety.js} fails on a planted silent swallow.
 */

export async function deliverButSwallow(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch {
  }
}
