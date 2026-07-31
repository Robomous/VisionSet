/**
 * Saving a file the API will only hand over to a credentialed request.
 *
 * The **fourth** instance of the same finding, and the first where the payload is
 * not an image: every route but `/health` authenticates with
 * `Authorization: Bearer`, and neither `<img src>` nor `<a href download>` sends
 * one — the browser issues those requests itself, with cookies and nothing else.
 * So a download is a `fetch` through the typed client, an object URL, and an
 * anchor clicked once.
 *
 * `a.click()`, never `dispatchEvent`. Not only because `tests/scripts/annotator_boundary.test.mjs`
 * scans every tracked frontend file for a constructed or dispatched DOM event —
 * that gate exists for the annotator, and this is not it — but because a
 * synthesised `MouseEvent` is not user activation and Chrome may refuse the
 * download outright. The native method is the one browsers trust.
 *
 * The URL is revoked in a microtask rather than immediately: revoking before the
 * navigation the click starts has been taken cancels it, and revoking never leaks
 * a whole export archive for the life of the tab.
 */

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  // Appended, because Firefox historically ignored a click on a detached anchor.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
