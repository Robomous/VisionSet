# Visual baselines

Ten reference images, compared pixel for pixel, produced in one Linux container
and nowhere else.

They exist to catch what an assertion cannot see: a token resolving to the wrong
colour, a font that failed to load, an icon that stopped drawing, a radius or a gap
that moved. They do not replace the behavioural specs beside them — those still own
navigation, focus, keyboard, requests and overflow, and a screenshot is a poor way
to ask any of those questions.

## The canonical environment

A screenshot compares two renderings, so everything the renderer reads is stated
rather than inherited. The `visual` project in `playwright.config.ts` pins the
locale, the timezone and `deviceScaleFactor`; the container pins the browser.

```
image              mcr.microsoft.com/playwright:v1.62.1-noble
os                 Ubuntu 24.04 LTS
node               v24.18.1
pnpm               10.30.2
playwright         1.62.1
chromium           151.0.7922.34
deviceScaleFactor  1
locale             en-US
timezone           UTC
```

Baselines are **not** generated on macOS or Windows. Font rasterisation differs
between operating systems, and a baseline captured on one and compared on another
reports that difference as a product regression.

## Running the comparison

```bash
docker run --rm \
  -v "$PWD:/repo:ro" -w /repo \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  bash -lc 'corepack enable && pnpm install --frozen-lockfile \
    && pnpm --filter @visionset/annotator build \
    && pnpm --filter @visionset/ui-core build \
    && cd frontend/app && CI=1 pnpm exec playwright test --project=visual'
```

The `visual` project is excluded from the default `chromium` project, so the
ordinary suite does not compare images and this command is the only thing that
does.

## Updating a baseline

Only when the visual change is intended. The same container, with
`--update-snapshots`:

```bash
docker run --rm \
  -v "$PWD:/repo" -w /repo \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  bash -lc 'corepack enable && pnpm install --frozen-lockfile \
    && pnpm --filter @visionset/annotator build \
    && pnpm --filter @visionset/ui-core build \
    && cd frontend/app && CI=1 pnpm exec playwright test --project=visual --update-snapshots'
```

Then **look at the images** and run the comparison again before committing. A
regenerated baseline that nobody opened is a regression that has been written down
as the new truth. `git diff --stat` naming a `.png` under
`e2e/visual.spec.ts-snapshots/` is the signal that a review is owed.

Snapshots are never updated by an ordinary test run. There is no host-native path
for updating them.

## When a comparison fails

Playwright writes `expected`, `actual` and `diff` images plus a trace under
`frontend/app/test-results/`. Read the diff before reaching for a tolerance:
`maxDiffPixels` is `0` on purpose, and the first run was already stable in this
environment. A threshold added before the failure is understood is a threshold
that hides the next regression.

The usual causes, in the order worth checking: a font that had not finished
loading, an animation captured mid-play, a timestamp that fell back inside the
relative-age window, and a genuine layout change.

## Determinism, and what it rests on

The fixtures in `e2e/_visual.ts` answer every request the reference surfaces make,
so nothing reaches a live workspace. Identifiers are literals. Timestamps sit in
2024, beyond `formatWhen`'s one-week relative window, so a "Created" cell prints a
fixed date instead of an age that changes while you read it. Images are one inlined
1×1 PNG. Fonts are awaited before capture.

The suite is expected to pass three consecutive unchanged runs. If it does not, the
fixture is not deterministic yet and the baseline is not worth having.
