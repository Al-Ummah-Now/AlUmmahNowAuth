import type { Locator } from '@playwright/test';

/**
 * Put a password or one-time code into an input without Playwright recording it.
 *
 * locator.fill(value) and locator.type(value) put the value in the step title
 * (`Fill "<value>"`), which the HTML report embeds even with tracing off, and in the
 * trace. Here the step title is just "Evaluate". The evaluate argument still lands in
 * a trace, so every spec that reaches this helper (directly or through a fixture)
 * sets `test.use({ trace: 'off' })` at the top level of the file.
 *
 * Fits the plain server-rendered auth forms: sets the value through the native setter
 * and fires input/change so listeners still see the edit.
 */
export async function fillSecret(target: Locator, value: string): Promise<void> {
  await target.waitFor({ state: 'visible' });
  await target.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
