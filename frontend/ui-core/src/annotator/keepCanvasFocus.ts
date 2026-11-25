/**
 * A press on the chrome around a view leaves the keyboard where it was.
 *
 * The 2D canvas and the scan views read their shortcuts off their own root, so a
 * control that took the focus would leave every chord dead until the next click
 * on the picture. `mousedown` is where the browser moves focus, so that is where
 * it is refused. Not for a slider: cancelling its `mousedown` stops the thumb
 * following the pointer (#563).
 */
export function keepCanvasFocus(event: { preventDefault: () => void }): void {
  event.preventDefault();
}
