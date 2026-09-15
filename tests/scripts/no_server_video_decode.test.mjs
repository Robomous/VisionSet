// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// VisionSet decodes video in the browser and nowhere else. That is an architecture decision
// with no fallback: there is no server-side decoder to fall back *to*, and the whole point of
// removing ffmpeg was that an optional decoder is a decoder — it has to be installed, shipped,
// pinned for determinism and explained in the install instructions whether or not anyone uses
// it. Re-acquiring one would not announce itself. It would arrive as a convenience: a wheel
// with a WASM build in it, one `apt-get install ffmpeg` line added back to a Dockerfile to make
// a job green, a `VideoProcessor` port reintroduced "just for the CLI".
//
// So the rule is machine-checked rather than remembered. This gate reads `git ls-files` — the
// index, like the other gates here, so a violation staged for commit is caught and an untracked
// scratch file is not — and refuses the banned names anywhere they could *run*.
//
// Prose is deliberately out of scope. Markdown is skipped entirely, because the migration that
// removed ffmpeg has to remain documentable: `docs/content/media.md` and `CHANGELOG.md` both
// need to say the word, and a gate that made the history unwritable would be traded away the
// first time someone needed to explain why video import works the way it does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SELF = "tests/scripts/no_server_video_decode.test.mjs";

/** Every tracked file, from the index rather than the working tree. */
function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

// Markdown carries the history; everything else here is something that executes, installs,
// resolves a dependency or configures a build. Lockfiles are in scope on purpose: a transitive
// WASM codec is exactly the arrival this gate exists to notice.
const SKIPPED_EXTENSIONS = new Set([".md", ".mdx", ".webm", ".mp4", ".mov", ".mkv", ".png", ".jpg", ".jpeg", ".ico", ".woff2"]);

const BANNED = [
  {
    pattern: /\bFfmpegVideoProcessor\b/,
    why: "the ffmpeg adapter is deleted; video decoding happens in the browser",
  },
  {
    pattern: /\bVideoProcessor\b/,
    why: "the server-side VideoProcessor port is deleted — the browser-side port is VideoMaterializer",
  },
  {
    pattern: /\bffmpeg\b|\bffprobe\b/i,
    why: "no VisionSet code, image, workflow or test may invoke or install ffmpeg/ffprobe",
  },
  {
    pattern: /@ffmpeg\/|ffmpeg\.wasm/i,
    why: "a WASM decoder is still a server-side decoder, and still a fallback this architecture refuses",
  },
  {
    pattern: /@mediabunny\/server/,
    why: "Mediabunny's server build decodes outside the browser; VisionSet uses the browser build only",
  },
  {
    pattern: /\blibav(codec|format|util)\b|\bPyAV\b|\bimport av\b|\bfrom av\b|\bimageio-ffmpeg\b|\bdecord\b/i,
    why: "a native decoding library is the same regression wearing a different name",
  },
  {
    // The likeliest accidental reintroduction, and the one a name-based ban misses: OpenCV
    // is already resolvable here through the local-inference extra, and `cv2.VideoCapture`
    // is a complete server-side decoder. Nothing bans importing a package that is installed,
    // so the capability has to be banned by name at its call site.
    pattern: /\bVideoCapture\b|\bcv2\.Video/,
    why: "cv2.VideoCapture is a server-side video decoder, whatever package it arrived in",
  },
];

test("nothing that runs, installs or resolves can bring back a server-side video decoder", () => {
  const offences = [];
  for (const file of trackedFiles()) {
    if (file === SELF) continue;
    if (SKIPPED_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;

    let text;
    try {
      text = readFileSync(path.join(REPO, file), "utf8");
    } catch {
      continue; // unreadable or binary — nothing executable we can assert about
    }

    for (const { pattern, why } of BANNED) {
      const lines = text.split("\n");
      for (const [index, line] of lines.entries()) {
        if (pattern.test(line)) {
          offences.push(`${file}:${index + 1}: ${line.trim()}\n    → ${why}`);
        }
      }
    }
  }

  // Capped rather than dumped: on the commit that first removed ffmpeg this listed two hundred
  // occurrences, and a wall of them is harder to act on than the first few plus a count.
  const shown = offences.slice(0, 25);
  const rest = offences.length - shown.length;
  assert.equal(
    offences.length,
    0,
    `server-side video decoding must not return — ${offences.length} occurrence(s):\n\n` +
      `${shown.join("\n\n")}\n${rest > 0 ? `\n…and ${rest} more.\n` : ""}\n` +
      "If an occurrence is genuinely historical prose, it belongs in a Markdown file, which this gate skips.",
  );
});

test("the gate actually fires", () => {
  // A gate nobody has seen fail is a gate nobody knows works. The probe never touches the
  // repository: the banned patterns are pure functions of a string, so a string is enough.
  const probes = [
    'processor = FfmpegVideoProcessor()',
    'from visionset.kernel.ports import VideoProcessor',
    "RUN apt-get install -y ffmpeg",
    'subprocess.run(["ffprobe", "-show_streams"])',
    '"@ffmpeg/ffmpeg": "^0.12.0"',
    '"@mediabunny/server": "^1.0.0"',
    "import av",
    "from av import VideoFrame",
    "cap = cv2.VideoCapture(path)",
  ];
  for (const probe of probes) {
    assert.ok(
      BANNED.some(({ pattern }) => pattern.test(probe)),
      `no banned pattern matched: ${probe}`,
    );
  }
});

test("the migration stays documentable and the browser stack stays allowed", () => {
  // The two false positives that would make this gate a liability rather than an asset.
  const allowed = [
    "VisionSet used to decode video with ffmpeg; it no longer does.", // prose, and .md is skipped anyway
    "import { Input, BlobSource, CanvasSink } from 'mediabunny';",
    "export class MediabunnyVideoMaterializer implements VideoMaterializer {",
    '"mediabunny": "1.56.1"',
  ];
  for (const line of allowed.slice(1)) {
    assert.ok(
      !BANNED.some(({ pattern }) => pattern.test(line)),
      `the browser stack must stay allowed, but a pattern matched: ${line}`,
    );
  }
});
