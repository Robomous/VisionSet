# Visual baselines

Fourteen reference images, compared pixel for pixel, produced in one Linux container
and nowhere else — and kept on the machine that produced them, never in git.

They exist to catch what an assertion cannot see: a token resolving to the wrong
colour, a font that failed to load, an icon that stopped drawing, a radius or a gap
that moved. They do not replace the behavioural specs beside them — those still own
navigation, focus, keyboard, requests and overflow, and a screenshot is a poor way
to ask any of those questions.

## The images

| Image | Surface | Captured |
| --- | --- | --- |
| `projects-desktop-light.png`, `projects-desktop-dark.png` | the shell and the project list: rail, page header, table, thumbnails | the window |
| `settings-desktop-light.png`, `settings-desktop-dark.png` | the rail's bottom group with Settings current, the page's section column and its About card | the window |
| `schema-desktop-dark.png` | the project's Schema section: inputs, labels, the class ledger | the project screen |
| `schema-narrow-light.png` | the same at 420px, where the action row wraps | the project screen |
| `models-desktop-light.png`, `models-desktop-dark.png` | the Models table: badges and technical text | the Models screen |
| `menu-open-light.png`, `menu-open-dark.png` | a batch's row menu, the inverted floating surface | the menu |
| `annotator-desktop-light.png`, `annotator-desktop-dark.png` | the annotation page on an image: top bar, tools, stage, panel | the window |
| `scan-desktop-light.png`, `scan-desktop-dark.png` | the annotation page on a scan: the WebGL view, its points on each theme's ramp, a cuboid, the stage | the window |

Why these surfaces and not the route list is argued at the top of `e2e/visual.spec.ts`.
Every dark image except the scan's adds `.dark` after the page loads; the scan's asks
for a dark `prefers-color-scheme` before it, so the view's first frame is already dark
and the shipped System path, not a class flip, is what is photographed.

## The canonical environment

A screenshot compares two renderings, so everything the renderer reads is stated
rather than inherited. The `visual` project in `playwright.config.ts` pins the
locale, the timezone and `deviceScaleFactor`; the container pins the browser.

```
image              mcr.microsoft.com/playwright:v1.65.1-noble
os                 Ubuntu 24.04 LTS
node               v26.13.1 (the image's; it runs the runner and vite, not the renderer)
pnpm               12.4.1 (package.json's packageManager)
playwright         1.65.1
chromium           159.0.8154.6
deviceScaleFactor  1
locale             en-US
timezone           UTC
```

The image's tag is the lockfile's `@playwright/test` version, and moves with it: Playwright
refuses to run in an image built for another release. Its Node ships without corepack, so
the commands install the pnpm that `packageManager` names instead of enabling it.

Baselines are **not** generated on macOS or Windows. Font rasterisation differs
between operating systems, and a baseline captured on one and compared on another
reports that difference as a product regression.

## Where the images live

`frontend/app/e2e/visual.spec.ts-snapshots/` is git-ignored. The first run in the
container writes the fourteen baselines there; every later run compares against them.
A comparison is therefore a statement about *this checkout since its baselines were
taken*: capture them on the merge-base before starting a visual change, then compare
after it, and the diff is the change and nothing else. The `visual` project exists only
while `VISIONSET_VISUAL` is set, so CI's `pnpm e2e` and a bare `playwright test` never
look for the images; the container commands below set it.

## Running the comparison

```bash
docker run --rm -e CI=true -e VISIONSET_VISUAL=1 \
  -v "$PWD:/repo" -w /repo \
  mcr.microsoft.com/playwright:v1.65.1-noble \
  bash -lc 'npm install -g pnpm@12.4.1 && pnpm install --frozen-lockfile \
    && pnpm --filter @visionset/annotator --filter @visionset/media --filter @visionset/browser-inference build \
    && pnpm --filter @visionset/ui-core build \
    && cd frontend/app && CI=1 pnpm exec playwright test --project=visual'
```

`-e CI=true` is what lets pnpm replace a host-installed `node_modules` without a
terminal to ask on, and the mount is writable because Playwright writes its report
and `test-results/` beside the spec. The container runs as root, so what it writes there
(`node_modules`, every `dist/`, the snapshots) is root's until handed back — for instance with
`docker run --rm -v "$PWD:/repo" alpine:3 chown -R "$(id -u):$(id -g)" /repo`. Afterwards the
host's `node_modules` holds Linux binaries: run `CI=true pnpm install --frozen-lockfile` and rebuild the four libraries
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
  mcr.microsoft.com/playwright:v1.65.1-noble \
  bash -lc 'npm install -g pnpm@12.4.1 && pnpm install --frozen-lockfile \
    && pnpm --filter @visionset/annotator --filter @visionset/media --filter @visionset/browser-inference build \
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
1×1 PNG. The scan is a point buffer built from integer steps, never a random draw,
and the canvas draws on demand, so it is captured once its draw count has stopped
moving. Its WebGL2 is the container Chromium's software renderer (SwiftShader), which
CI's point-cloud spec relies on too. Fonts are awaited before capture.

The suite is expected to pass three consecutive unchanged runs. If it does not, the
fixture is not deterministic yet and the baseline is not worth having.
