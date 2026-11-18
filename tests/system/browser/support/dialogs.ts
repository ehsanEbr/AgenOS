import { expect, type Locator, type Page } from '@playwright/test';
import { staysTrue } from '../../src/wait';

/*
 * What a dialog does with the keyboard and the mouse, in a REAL browser. (Finding of this step: Ant Design's `Modal` ignores every cancel
 * while `confirmLoading` is set, so while a request runs Escape, the mask and the close button do nothing whatever `keyboard` is. The
 * dialogs' `keyboard={!pending}` and `closable={!pending}` props are therefore defense in depth, and the close BUTTON's absence is the
 * only one of them a person can see. These tests guard the behavior, whichever mechanism provides it.)
 * The component tests cannot show this: under jsdom Ant Design's
 * Escape handling does not reach the dialog, so they check the props the dialog passes to `Modal` instead (note 23 of ADR-0012). Here
 * the keys are pressed and the mouse is clicked.
 *
 * Every check that something does NOT happen is paired with a check of the same action in a state where it DOES happen (the idle dialog
 * closes on Escape), so a key press that never reached the dialog cannot make the "protected" check pass by accident.
 */

/**
 * The dialog is still open, and stays open. A dialog leaves with a short animation (about 300 ms): right after a dismissal it is still on
 * screen, so a single "is it visible" check made at once would pass even though the dialog is closing. That the dialog does NOT close
 * can only be observed over a window of time, so this is a bounded wait on an invariant (`staysTrue`, as elsewhere in this project's
 * system tests), long enough to outlast the animation, and it fails the moment the dialog is gone.
 */
async function staysOpen(dialog: Locator): Promise<void> {
  await staysTrue(() => dialog.isVisible(), 900, 'the dialog stays open', 100);
}

/** Whether the keyboard focus is inside the dialog, which is where an Escape press has to start for the dialog to receive it. */
export async function focusIsInside(dialog: Locator): Promise<boolean> {
  return dialog.evaluate((element) => {
    // The project has no DOM typings (it is a Node project); the page's `document` is reached structurally.
    const page = globalThis as unknown as { document: { activeElement: unknown } };
    return (element as unknown as { contains(node: unknown): boolean }).contains(page.document.activeElement);
  });
}

/** The dialog is open and idle: Escape closes it, a click on the mask does not, and Cancel does. `reopen` opens it again afterwards. */
export async function expectIdleDismissal(
  page: Page,
  dialog: Locator,
  cancel: Locator,
  reopen: () => Promise<void>,
): Promise<void> {
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible(); // the close button is offered while nothing is running
  await expect.poll(() => focusIsInside(dialog), { message: 'focus is inside the dialog' }).toBe(true);

  // A click outside the dialog (on the mask) does not dismiss it: `maskClosable` is off, so a stray click cannot lose typed input.
  await page.mouse.click(2, 2);
  await staysOpen(dialog);

  // Escape closes it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // So does Cancel.
  await reopen();
  await expect(dialog).toBeVisible();
  await cancel.click();
  await expect(dialog).toBeHidden();
}

/**
 * The dialog's request is held on its way to the server. While it runs, Escape, a click on the mask and the close button do nothing
 * and Cancel is disabled; when the request is let go the dialog finishes normally. `confirm` starts the request.
 */
export async function expectProtectedWhileRunning(
  page: Page,
  dialog: Locator,
  confirm: Locator,
  cancel: Locator,
  request: { method: string; url: RegExp },
): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  await page.route(request.url, async (route) => {
    if (route.request().method() !== request.method) return route.fallback();
    held += 1;
    await gate;
    return route.continue();
  });

  try {
    await expect(dialog).toBeVisible();
    await confirm.click();
    await expect.poll(() => held, { message: 'the request is on its way' }).toBe(1);

    // Running: nothing dismisses it.
    await expect(cancel).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Close' })).toHaveCount(0);
    await expect.poll(() => focusIsInside(dialog), { message: 'focus is inside the dialog' }).toBe(true);
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    await staysOpen(dialog);
    await expect(cancel).toBeDisabled();
    expect(held, 'pressing Escape must not send a second request').toBe(1);
  } finally {
    release();
  }
  await expect(dialog).toBeHidden(); // the request finished and the dialog went with it
  await page.unroute(request.url);
}
