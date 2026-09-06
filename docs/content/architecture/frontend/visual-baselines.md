# Visual baselines

Ten reference images, compared pixel for pixel, produced in one Linux container
and nowhere else — and kept on the machine that produced them, never in git.

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

## Where the images live

`frontend/app/e2e/visual.spec.ts-snapshots/` is git-ignored. The first run in the
container writes the ten baselines there; every later run compares against them.
A comparison is therefore a statement about *this checkout since its baselines were
taken*: capture them on the merge-base before starting a visual change, then compare
after it, and the diff is the change and nothing else. The `visual` project exists only
while `VISIONSET_VISUAL` is set, so CI's `pnpm e2e` and a bare `playwright test` never
look for the images; the container commands below set it.

## Running the comparison

```bash
docker run --rm -e CI=true -e VISIONSET_VISUAL=1 \
  -v "$PWD:/repo" -w /repo \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  bash -lc 'corepack enable && pnpm install --frozen-lockfile \
    && pnpm --filter @visionset/annotator build \
    && pnpm --filter @visionset/ui-core build \
    && cd frontend/app && CI=1 pnpm exec playwright test --project=visual'
```

`-e CI=true` is what lets pnpm replace a host-installed `node_modules` without a
terminal to ask on, and the mount is writable because Playwright writes its report
and `test-results/` beside the spec. Afterwards the host's `node_modules` holds Linux
binaries: run `CI=true pnpm install --frozen-lockfile` and rebuild the two packages
before running vitest natively again.

The `chromium` project ignores `visual.spec.ts` and the `visual` project is absent
without the variable, so the ordinary suite never compares images and this command
is the only thing that does.

## Retaking a baseline

Only when the visual change is intended. The same container, with
`--update-snapshots`, rewrites every baseline whose surface changed and leaves the
rest byte-identical:

```bash
docker run --rm -e CI=true -e VISIONSET_VISUAL=1 \
  -v "$PWD:/repo" -w /repo \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  bash -lc 'corepack enable && pnpm install --frozen-lockfile \
    && pnpm --filter @visionset/annotator build \
    && pnpm --filter @visionset/ui-core build \
    && cd frontend/app && CI=1 pnpm exec playwright test --project=visual --update-snapshots'
```

Then **look at the images** and run the comparison again. A retaken baseline that
nobody opened is a regression that has been written down as the new truth; the
run's own `is re-generated` lines name the files a review is owed on.

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
