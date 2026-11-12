/**
 * A date control closing: close first, then write only if the person chose a day (`undefined`: they did not, as with
 * Escape or a click elsewhere with nothing typed) and it differs from the live `value`, then whatever follows the close.
 * The draft is never written back as it was opened: the date may have changed underneath while the calendar was open.
 */
export function finishDate(value: string | null, day: string | null | undefined, close: () => void, write: (day: string | null) => void, after?: () => void): void {
  close();
  if (day !== undefined && day !== value) write(day);
  after?.();
}
