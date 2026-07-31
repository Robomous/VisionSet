/**
 * The demo's picture: generated, not committed.
 *
 * `tests/architecture/test_tracked_file_sizes.py` caps any tracked file at
 * 200 KB and the repository's standing rule is that fixture media is never
 * committed — `tests/fixtures/media.py` generates every image and clip the Python
 * suite uses, for exactly this reason. A sample image for the annotator is the
 * same problem on the other side of the wire, so it gets the same answer: an SVG
 * built in code and handed over as a `data:` URI, which is text all the way down.
 *
 * The rulers are not decoration. Annotation geometry is in the asset's own pixels
 * and is never normalized, so the one bug this demo exists to make visible is a
 * transform that is subtly wrong — and a box whose reported `x` is 400 sitting
 * over a line labelled 400 is the cheapest possible check of that.
 */

/** The frame every coordinate in this demo is measured in. */
export const SAMPLE_ASSET = { id: "demo-asset-0001", width: 1280, height: 720 } as const;

const GRID = 80;
const LABEL_EVERY = 160;

function grid(): string {
  const lines: string[] = [];
  for (let x = GRID; x < SAMPLE_ASSET.width; x += GRID) {
    const major = x % LABEL_EVERY === 0;
    lines.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${SAMPLE_ASSET.height}" stroke="#2b3648" stroke-width="${major ? 2 : 1}"/>`,
    );
    if (major) lines.push(`<text x="${x + 4}" y="16" fill="#5b6b85" font-size="12">${x}</text>`);
  }
  for (let y = GRID; y < SAMPLE_ASSET.height; y += GRID) {
    const major = y % LABEL_EVERY === 0;
    lines.push(
      `<line x1="0" y1="${y}" x2="${SAMPLE_ASSET.width}" y2="${y}" stroke="#2b3648" stroke-width="${major ? 2 : 1}"/>`,
    );
    if (major) lines.push(`<text x="4" y="${y - 4}" fill="#5b6b85" font-size="12">${y}</text>`);
  }
  return lines.join("");
}

/** Something to draw around: a road, two vehicles and a figure. */
function subjects(): string {
  return [
    `<polygon points="380,720 560,320 720,320 900,720" fill="#1b2433"/>`,
    `<polygon points="632,700 638,340 642,340 648,700" fill="#3a4a63"/>`,
    `<rect x="520" y="452" width="160" height="112" rx="12" fill="#2f6f8f"/>`,
    `<rect x="546" y="472" width="108" height="44" rx="6" fill="#8fd3f4"/>`,
    `<rect x="742" y="386" width="96" height="70" rx="10" fill="#6b4f8a"/>`,
    `<circle cx="988" cy="404" r="18" fill="#d9b38c"/>`,
    `<rect x="974" y="424" width="28" height="74" rx="10" fill="#c1734a"/>`,
    `<circle cx="196" cy="150" r="52" fill="#f3d16b"/>`,
  ].join("");
}

/**
 * The sample image as a `data:` URI.
 *
 * Not URL-encoded by hand: `#` alone would truncate every colour in the document
 * at the fragment separator, which fails as a *blank* image rather than as an
 * error.
 */
export const SAMPLE_IMAGE_SRC = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SAMPLE_ASSET.width}" height="${SAMPLE_ASSET.height}" font-family="system-ui, sans-serif">` +
    `<rect width="${SAMPLE_ASSET.width}" height="${SAMPLE_ASSET.height}" fill="#101722"/>` +
    grid() +
    subjects() +
    `<rect x="1" y="1" width="${SAMPLE_ASSET.width - 2}" height="${SAMPLE_ASSET.height - 2}" fill="none" stroke="#3d4c66" stroke-width="2"/>` +
    `<text x="${SAMPLE_ASSET.width - 8}" y="${SAMPLE_ASSET.height - 10}" text-anchor="end" fill="#5b6b85" font-size="14">` +
    `${SAMPLE_ASSET.width} × ${SAMPLE_ASSET.height} — asset pixels</text>` +
    `</svg>`,
)}`;
