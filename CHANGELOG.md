# Changelog

All notable changes to VisionSet. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[PEP 440](https://peps.python.org/pep-0440/) for the Python distribution and the equivalent npm
semver for the frontend packages, both derived from the repository-root `VERSION`.

Six internal milestones (M1–M6) got here. The first five ended in a **git tag only** —
`v0.0.1-alpha.1` … `v0.0.1-alpha.5`, with `VERSION` sitting at `0.0.1.dev0` throughout, because
nothing was being distributed. This is the first version that is.

## [Unreleased]

### Added

- **A schema version records which kind of work published it** (#368). New nullable
  `provenance` on `AnnotationSchema`: `curated` for a version somebody sat down and designed,
  `annotation` for one that fell out of adding a class part-way through labeling. It gates
  nothing, enters no diff, and two versions differing only in provenance are the same
  contract — it exists so a version history can tell the milestones apart from the runs
  between them.

  Each writer states its own answer, because what makes a version incidental is the *surface*
  it came from and never the size of the change: the browser's Schema tab and
  `visionset schema apply` say `curated`, the annotator's add-class dialog says `annotation`,
  and the MCP tool takes an optional parameter defaulting to `curated`. An SDK caller may say
  nothing.

  Migration 5 (`schema_provenance`) appends the column and `FORMAT_VERSION` becomes 5.
  **Nothing is backfilled and nothing could be** — no build ever recorded which surface
  published a version, so every existing one reads as "nobody said", which a reader groups
  with `curated`. Not to be confused with `Annotation.provenance` (`human` / `model` /
  `import`), which is a different question about a different entity.

- **`⌘/Ctrl + C` and `⌘/Ctrl + V` in the annotator, and the clipboard survives moving to the next
  frame** (#123). Copy the selection, walk forward, paste it — the second half is the point: the
  clipboard is held per *job*, above the per-asset store, because a store carries an undo history
  that must not follow you between frames. It is the annotator's own clipboard, never the system
  one: what is copied is a geometry in that asset's pixel frame, meaningless anywhere else.

  A paste re-mints every id, reads `asset_id` and `schema_version` off the frame it lands on,
  and is **one** undo step however many annotations it carries. It offsets by 20 *screen* pixels
  — v1's number, divided by the live zoom, so the copy is grabbable at a fitted 20% and not
  flung across the pane at 8× — steps further out rather than stacking when a repeat would land
  on the copy before it, and clamps into a smaller frame the way dragging into the edge does,
  keeping the shape rather than flattening it. Pasting a classification tag the frame already
  carries does nothing, so a duplicate cannot reach the kernel's `DUPLICATE_CLASSIFICATION_TAG`.

  Copy is a read and works in a read-only view — carrying a box out of a completed batch is how a
  correction starts; paste is refused there by the engine itself. In a text field both chords stay
  the browser's. See `docs/annotations.md`.

- **An embedded job system: work that outlives its request now has a queue, and it survives a
  restart** (#328). The whole background story was 77 lines — a one-worker `ThreadPoolExecutor`
  holding closures in memory, reachable from two lambdas, losing everything queued when the
  server stopped. There is now a `JobQueue` port with a SQLite adapter (a `job` table in the
  workspace's own database, migration 4), a `ProgressReporter` port, and a dispatcher thread in
  the FastAPI lifespan feeding a `spawn` `ProcessPoolExecutor`. No separate worker command:
  `visionset server` still starts everything.

  The claim is one guarded `UPDATE` whose `rowcount` is the answer — the shape
  `set_asset_progress` already uses — so two dispatchers can never hand one job to two workers.
  A row left `running` by a dead server is settled at the next startup, and an idempotent one is
  re-queued as a **new** job so a list shows the crash *and* the recovery. `spawn` is pinned
  rather than defaulted: `fork` is unsafe beside a live pooled SQLite connection.

  Handlers live in a new `visionset.jobs` package — a sibling of `formats` and `wire` — because
  the export handler resolves a format plugin, which the kernel may not import. Two new
  import-linter contracts hold both directions; the second is load-bearing, since a worker that
  imported `visionset.server` would re-execute its module-level `app = create_app()` under
  `spawn`. See `docs/background-jobs.md`.

- **`GET /background-jobs`, `/background-jobs/{id}`, `/background-jobs/{id}/cancel` and
  `/background-jobs/{id}/artifact`** (#328). The generic twin of `/ingest-jobs`. Not `/jobs`:
  that prefix has served *annotation* jobs since #29 and two different things wanted the word.
  There is deliberately no `POST` — a generic launch route taking a type and a payload would be
  a remote-code surface, so every launch stays on the resource it is about.

- **`VISIONSET_JOB_WORKERS`, `VISIONSET_JOB_POLL_INTERVAL_S` and
  `VISIONSET_JOB_PROGRESS_MIN_INTERVAL_S`** (#328), through this repository's first
  `pydantic-settings` object. The default is **one** worker, and that is a property of the store
  rather than a cautious guess: SQLite has a single writer and a run writes progress as it goes.

### Changed

- **The annotator's top bar has a verb for finishing a frame** (#383). Dogfooding #368's bar
  found that the commonest move in the product had no button: after annotating a frame, the
  thing to do is store it and go to the next one, and the only control that advanced was the
  navigator's `›` chevron — chrome rather than a verb. So **Skip** inherited prominence by
  vacuum and became the most obvious thing to press on work somebody had just done.

  **Save and next** is the bar's one filled control now, on `↵`, and **Skip** is beside it on
  `X`: two ways to resolve this frame — annotated or skipped — that both advance, and
  neither collapses into the overflow. It is the navigator's own save-first advance and not a
  second pipeline, so a refused save keeps you on the frame with the refusal on screen. It reads
  **`Next`** when no save will happen, because a button must not promise one it will not
  perform. On the last frame it is not rendered at all and **Finish job** takes the filled slot,
  which is the only place the two could have contended.

  The review move (**Submit for review**, else **Accept**) is an outline control rather than the
  primary, and submitting now says what it means — this product has no annotator identity, so a
  submitted frame is *marked for a review pass*, not routed to anybody. **Save and stay** comes
  back onto the bar as a ghost button: #368 removed it because ⌘S and every exit already save,
  and what that missed is that the chord is invisible. When the bar runs out of room it is the
  first thing reabsorbed into the overflow, the review move the second.

  `enter` now has two meanings and they never overlap: it is still the polygon ring close, and
  with nothing being drawn the React adapter reads it as the flow verb. `x` is a new row in the
  default binding table. Hotkey chips are printed on the ghost and outline controls only — they
  are a lighter-than-the-surface treatment, so on the one filled button a chip inverts into a
  dark box inside a dark button and reads as a smudge (#385); the shortcut sheet carries every
  chord regardless, derived from the live registry. Left of the bar, the progress dot gains its
  word — one microtext reading `● annotated · Saved`, because a tooltip is a place a word goes
  to not be read.

- **The annotation workspace is reorganized around where each control belongs** (#368). The top
  bar was one undifferentiated row of thirteen controls in which a navigation arrow, the save
  state and the button that ends the job all looked alike; the side panel was two tabs, and the
  Labels tab did two unrelated jobs under one heading. Both are re-cut.

  The **top bar** is three zones — where you are, what you are drawing, what happens next. The
  drawing class moves into the middle of it as a combobox with typeahead, recently-used first and
  a `Create class "…"` row when nothing matches; `c` opens it and the digits still work. Exactly
  **one** workflow primary is rendered, from the wire's own `allowed_actions`; Skip stays a
  visible secondary and the rest move to an overflow. The Save *button* is gone and `⌘/Ctrl + S`
  now exists — it never had a binding, so removing the button without adding one would have left
  save-on-navigate as the only way to store work in place. Zoom and a new fullscreen control move
  to a floating widget on the stage; undo and redo become visible tool-strip buttons.

  The **side panel** is one Annotations view. Class *selection* left it for the top bar, so the
  Labels tab is gone and the panel can no longer arm a drawing class at all; the one capability
  that tab uniquely held — toggling the asset's classification tags — stays, as a chip strip
  above the object list, rendered when the pinned schema declares a tag class. An always-present
  filter narrows the list without renumbering it, because the number is the object's identity on
  the canvas. Class reassignment moves from a card under the selection to a per-row menu, and it
  now lists **every** class with the geometry-incompatible ones disabled and carrying the reason
  (`needs a polygon`) rather than filtered out — a short list with no explanation reads as a
  schema missing its classes.

  **Adding a class mid-job is a session**, and one session is one published schema version.
  `Create and add another` (`⌘/Ctrl + ↵`) banks a class and clears the form; the primary
  publishes everything banked in one go, under one auto-written description naming them all.
  Cancelling with classes banked asks first — and asks on Escape too, since everything a session
  holds lives in the browser. The create row in the class field now carries the name that was
  typed into the dialog instead of dropping it. When it lands, the last class written becomes the
  drawing class and a toast says so.

  Related, and a promise the page could not previously keep: **the drawing class now survives the
  re-pin that follows publishing, and moving to the next frame.** It was held in a component
  keyed on the asset, and re-pinning changes the pinned-schema query key — so the class somebody
  had just created was armed and silently discarded a moment later by the refetch the re-pin
  caused. Its lifetime is now the job, the same scope the clipboard has.

  The **pinned `v{n}` badge** answers the question it raises. Pressing it says whether the batch's
  version is still the project's current one and, when it is not, what arrived since — fetched
  only on opening, because the editor is judged against the pin and a page that read the active
  version on arrival would offer classes the API then refuses.

  The project's **version history groups the versions the annotator published**: consecutive
  versions whose provenance is `annotation` collapse into one expandable row, so the curated
  milestones somebody opened the table to read are not buried under a run of `Added class "cone"
  from the annotation view`. Curated versions, and versions from before provenance existed, always
  render on their own; a run of one is not a run.

  Behind it, one ratified principle: **the annotation workspace is self-sufficient — no flow may
  force navigation out of the editor, and no exit may lose work.** Back and grid save first.

  The `Tabs` `segmented` variant is retired with the switch that was its only caller, and with it
  the `variant` prop, the context that carried it and the `data-variant` attribute.

- **The annotator's zoom has a named ceiling, honest pixels at depth, and controls that say when
  they stop** (#228). The maximum is **8x**, where one asset pixel is already an eight-pixel
  block and further magnification produces larger blocks of the same data; it was 16. Above
  **4x** the image layer renders `image-rendering: pixelated`, so deep zoom shows the asset's
  real sampling grid instead of gradients the browser invented between the pixels somebody
  zoomed in to look at — the annotation chrome is untouched by the rule.

  The annotation page's `−`/`+` used to stay enabled at both ends of the range and do nothing
  when pressed. They now carry `aria-disabled` and a tooltip naming the limit ("Maximum zoom —
  8× image pixels"), and the readout stops at exactly `800%`. `aria-disabled` rather than the
  native attribute, because a disabled `<button>` takes no pointer events and its tooltip would
  never open — a disabled-with-reason control whose reason cannot be read is a bare disabled
  control.

  This closes out #131's measurement: the frame ceiling at depth is the browser's raster of a
  scaled stage, not anything this codebase executes, so it is accepted as a limit rather than
  chased. Vector re-rendering of the annotation chrome is deferred to `cf. #342`.

- **The MCP server retires `start_job`: the first write starts the job** (#109). **Breaking for
  MCP clients**, and for that surface only — the REST route and the CLI are untouched. An agent
  no longer marks a job as being worked on: `add_annotations`, `update_annotations`,
  `delete_annotations`, `set_asset_progress` and `complete_job` each take a `pending` job to
  `in_progress` on the way in, and each publishes **`job_started`** in its answer so the move is
  never invisible. Thirty-eight tools, down from thirty-nine.

  The evidence is #36's twelve real agent runs: two of them labeled a whole job and then had
  `complete_job` refuse, because writing is gated on the *batch* being `in_annotation` and never
  on the job, so nothing in the loop forced the call until the end. #36 answered that with tool
  descriptions pointing at each other; this removes the failure mode instead.

  **Adapter policy, not a domain change.** `JOB_TRANSITIONS` is untouched, `require_move` is
  still the funnel, and only `pending` moves — a `completed` job is left alone and a batch that
  is not `in_annotation` refuses first, so nothing is quietly marked as being worked on.
  `complete_job` starts a job too, which is not redundant: a correction batch cut over
  already-labeled assets opens fully settled, so its job can be finished with no edits and no
  other write would ever reach it.

- **`POST /releases/{id}/export` answers `202` instead of the archive** (#328). **Breaking, for
  this one endpoint.** It used to be a synchronous `FileResponse` that blocked until the exporter
  finished; a real format walks every asset in a release and copies its bytes, which is minutes
  of work behind a request with no way to report progress and every proxy's timeout in front of
  it. It now returns `202` with a job to poll and a `Location: /background-jobs/{job_id}`, and
  the archive comes from `GET /background-jobs/{job_id}/artifact` once that job reports
  `succeeded`.

  Everything a *request* can refuse is still refused on the request: an unknown format is a 404
  and an unconsented lossy export a 409, neither creating a job. The browser's consent flow is
  unchanged; the export dialog polls and downloads when the job succeeds.

- **Ingest runs on the same executor**, with no wire change at all (#328). `IngestJobOut` is
  still what a client polls and `POST /sources/{id}/ingest-jobs` still answers 202 with the same
  body — only who does the work moved. An ingest now has two rows for one run: the `ingest_job`
  is the domain record, the `job` is execution plumbing, and collapsing them is a later
  migration with its own wire discussion.

### Fixed

- **A broken internal doc link now fails a test instead of landing quietly at the top of the
  page** (#337). Renaming a `##` heading invalidates every inbound `#fragment` pointing at it, and
  nothing anywhere says so — the link still works, it just goes somewhere else, which is
  indistinguishable from correct unless you already knew which paragraph you were promised. A near
  miss during the `visionset ui` → `visionset server` rename (#329).

  `tests/scripts/docs_links.test.mjs` resolves every internal link and every anchor across all 46
  tracked Markdown files — 266 links, 551 headings — naming the file, the line and the dead
  fragment. It rides `pnpm test`, so it is in `check.sh` and in CI with no new job and no new
  dependency. External URLs are deliberately out of scope: a gate that goes red for somebody
  else's rate limit is one people learn to re-run rather than read. **No broken links were
  found** — the five its first run reported were all the checker being wrong (headings that are
  entirely inline code, and underscores in slugs), which is its own argument for the unit tests
  beside it.

- **`scripts/check.sh` says what it covered, on the stream a caller actually reads** (#336). It
  had aborted correctly on a missing `node_modules` since #249 — but on **stderr**, with nothing
  at all on stdout, so an agent or a CI step capturing stdout saw a partial run and a full one as
  the same thing: some green pytest output, then silence. The exit code was right, and nobody
  reads an exit code out of a transcript.

  Every run now ends with `check.sh: PASSED  ran=…  skipped=…` on stdout, printed from a
  `trap … EXIT` so no way out can skip it. `ran=` is what *completed*, never what was asked for,
  and `INCOMPLETE` is kept apart from `FAILED` because "the checks did not happen" and "the checks
  found something" are different news. The browser banner now follows what ran rather than what
  was requested — a run that asked for everything and died in `frontend` skipped those suites just
  as completely as `--fast` did — and stays quiet when nothing ran at all, so a usage error is not
  buried under twelve lines about Playwright. `tests/scripts/check_stages.test.mjs` guards it,
  including that every group the script knows is still dispatched: the way this rots is a stage
  quietly leaving the loop, which shrinks coverage while everything left passes.

- **The annotator's address bar names the frame on screen** (#353). `?asset=` recorded where the
  annotator was *entered*: the next and previous buttons moved through the job in the page's own
  state and never touched it, so after one press the URL named a different picture than the
  screen. Copy that link on frame 7 and the colleague you send it to lands on frame 1 — with
  nothing anywhere saying so, and answering about a picture that was never meant.

  Every frame change now rewrites it, with `replace` rather than `push`: Back still leaves the
  annotator instead of walking backwards one picture at a time, which would turn the browser's
  own button into an undo two keys away from the real one. A reload lands where you were, and a
  `?asset=` naming an asset this job does not carry is *corrected* in the address rather than
  falling back to the first frame in silence.

  It was also making tests lie: #223's cycle step read the frame out of the URL, wrote a lane
  against that id, and watched every assertion pass — against a frame that was not the one under
  test. `data-asset` on the page root was added then so a harness would stop having to ask the
  URL; the two now agree.

- **A batch whose every frame was finished could not be completed** (#301). `Complete` answered
  `BATCH_NOT_COMPLETE` beside a progress bar reading `0 to do`, and both were true: completion is
  derived at *two* levels — `BatchService.complete` refuses while any **job** is outstanding,
  `JobService.complete` while any **asset** is — and the browser only ever sent the outer one.
  `POST /jobs/{id}/complete` had a single caller in the whole app, the `Finish job` button inside
  the annotator, which somebody settling frames from the gallery never passes. `Complete` now
  finishes the batch's jobs first (starting any the annotator never opened, since
  `JOB_TRANSITIONS` has no `pending → completed` edge), and it is withheld with a count while
  frames are still outstanding rather than offered and refused. It is also on the gallery header
  now, which is the screen the work is done from.

- **A skip could not be taken back from the grid, and marking an already-skipped selection
  claimed to work** (#301). `skipped → unannotated` is a first-class edge in
  `ASSET_PROGRESS_TRANSITIONS` and had no spelling anywhere in the browser, so a mis-aimed
  shift-click over forty frames was unrecoverable without opening each one. Meanwhile
  `JobService.mark` treats a re-stated state as a documented no-op, answered `200` with nothing
  changed — so `Mark skipped` over already-skipped frames reported success over work it had not
  done. The bulk bar now offers `Mark skipped` **and** `Restore`, each counting only the selected
  frames its move is legal for and sending only those.

- **The way into the annotator disappeared once a batch had no unlabeled work left** (#301).
  `Start annotating` was drawn only while some frame was `unannotated`, so an `in_annotation`
  batch that was fully annotated or skipped rendered no action in its header at all. Opening a
  frame is legal whatever its state — the annotator lists a job's assets with no progress filter
  and carries `Un-skip` — so the door is now open whenever the batch has jobs, aimed at the first
  waiting frame when there is one and labelled for which of the two it is doing.

- **Bulk progress moves are sent one at a time.** Three concurrent moves over one job were
  measured answering `200`, `200`, `200` and moving exactly one asset: `JobService.mark` is a
  read-modify-write over one row through `session.merge`, and SQLite's single writer serializes
  *writes* rather than read-modify-write. That is a kernel-level hazard filed as **#302**; this
  release stops `ui-core` from causing it.

### Changed

- **`visionset ui` is now `visionset server`** (#329). The command starts the FastAPI server; the
  browser application is one client of it, alongside REST, the SDK and MCP, so the old name
  described a single consumer of the process rather than the process. Nothing else moved — same
  flags and defaults, same `/app` mount, same one-sentence refusal at exit 1 outside a workspace.

  **There is no alias.** `visionset ui` now fails with Typer's ordinary `No such command 'ui'`,
  so a script that calls the old name needs one edit. A deprecation shim was declined
  deliberately rather than overlooked: this is a pre-1.0 beta with no installed base to carry,
  and a hidden second spelling of the front door is a thing every later reader has to explain
  away.

- **The browser application moved from `/ui` to `/app`.** `visionset server` now serves it at
  `http://127.0.0.1:8000/app/`, and `/` still redirects there. One constant moved —
  `UI_PREFIX` in `src/visionset/server/main.py` — and `frontend/app/vite.config.ts`'s build
  `base` follows it, which is what keeps the router's basename in agreement: it is read from
  `import.meta.env.BASE_URL`, so nothing in the application names the prefix. The argument for
  *having* a prefix is unchanged (#33): the API owns the root, so an app at `/` could never
  claim `/projects/abc` as one of its own client routes.

  **This is a public URL change.** A bookmark or a pasted link under `/ui/…` now 404s; there is
  no redirect from the old prefix, because `/ui` is not a path the API answers on and adding a
  permanent redirect for a pre-1.0 beta would outlive the reason for it. The development stacks
  are untouched — `vite dev` and the compose stack both serve the app at `/`, and only a build
  has a base at all.

## [0.0.1b2] — 2026-07-31

The beta corrected. `0.0.1b1` shipped with every CI gate green — 2,000+ Python tests, 700
annotator vitest, 76 Playwright scenarios, a browser cycle against a real server, and a wheel
job — and a manual pass over the **built wheel** then found three things that made the
advertised flow wrong or unusable.

**The gap is the useful finding, and it shaped what this release adds.** Each defect sat in a
blind spot of an otherwise strong suite, and all three are the same shape: *a claim verified
against itself rather than against the artifact.* The export tests asserted the counts the code
intended, never the counts in the bytes on disk. The gallery's own docstring called its
one-column fallback "correct-but-slow rather than wrong", so its unit tests asserted exactly the
broken value. Every screen was tested in isolation and nothing walked the app the way a person
does.

So each fix ships with the guard that was missing, and every one of them was **verified by
mutation** — reintroducing the defect turns a named test red:

- an export report is now checked against the annotations actually written into the label files,
  XML documents and COCO JSON, for every installed format;
- the product is walked end to end **by clicking**, and the helper that let a spec type a job URL
  is deleted;
- the gallery's column count is measured in a real browser at two viewport widths.

### Fixed

- **`/favicon.ico` 404'd on every page** (#161) — the only console error in an otherwise clean
  load. `frontend/app/index.html` declared no icon, so the browser asked for one unprompted and
  the API root, which owns `/` deliberately (#33), correctly answered 404 in the one error body.
  Cosmetic on its own, and worth closing: a console that is empty when things are fine is worth
  more than one that always has a line in it.

  An inline SVG mark ships in `frontend/app/public/`, referenced root-relative so Vite's `base`
  rewrite puts it at `/ui/favicon.svg` in the build and `/favicon.svg` under `vite dev` — a
  literal prefix would have worked in the wheel and 404'd in development, silently either way.
  No `/favicon.ico` route was added to the API; the spec is the REST contract and a browser
  convenience file has no place in it.

- **The schema editor's colour swatch showed grey for a derived class colour** (#162), contradicting
  the dot two inches to its left and the colour the annotator actually draws — in the one control
  whose whole job is to say what colour something is. `<input type="color">` accepts only
  `#rrggbb`, `classColor` answers `hsl(...)` for a class with no declared colour, and the editor
  fell back to a neutral rather than converting.

  `hexColor` in `frontend/ui-core/src/palette.ts` converts the notation and nothing else — the rule
  stays `classColor`'s single spelling. Showing a colour still does not *declare* one: an untouched
  save sends `color: null` for a derived class, asserted on the request payload rather than on the
  control, so a schema version can never silently freeze today's hash output as if it had been
  authored. "Derive" still clears a declared colour, and now the swatch follows it.

- **The gallery rendered one tile per row at every viewport width** (#159). `useColumns` attached
  its `ResizeObserver` in an effect that began `if (element === null) return` — and the scroller it
  points at lives inside `<Async>`'s children render-prop, so on mount it does not exist yet. The
  effect took the early return, both of its dependencies were stable, and it never ran again once
  the real element arrived. `columns` stayed at its initial `1` for the life of the screen; a batch
  of six 160-px thumbnails occupied one 160-px column of a 1239-px pane.

  The arithmetic was correct throughout, which is why nothing caught it: `columnsFor(1239)` is 7
  and always was. Now the scroller is taken by a **callback ref** — React calls it with the node on
  attach and `null` on detach, so an effect keyed on that state re-runs by construction — and
  `useVirtualizer` reads the same state value, so the two halves of the screen cannot disagree
  about which element they are measuring.

  The guard is in `frontend/app/cycle/cycle.spec.ts`, against a real browser, because jsdom reports
  every element as 0×0 and the screen's unit tests were passing in exactly the state the bug
  produced. It asserts the rendered count agrees with what fits, that it is more than one at a wide
  viewport, and that narrowing the window re-flows the grid. Verified by mutation, both halves.

- **The annotator was unreachable from inside the UI** (#160). Every gallery tile rendered
  `disabled`, the annotator's own "Open the gallery" button rendered `disabled`, and nothing
  anywhere navigated to `/jobs/:jobId` — so the one thing the product is for could be reached only
  by pasting a URL whose job id came out of the REST API. `routes.tsx` never passed
  `GalleryScreen`'s `onOpenAsset`, while every sibling route wired its callbacks.

  Clicking a tile now opens the annotator **on that asset** (`/jobs/:jobId?asset=<id>`), because a
  click that landed on the fifth picture and opened the first reads as the click being ignored;
  the grid button returns to that batch's gallery, handed the project and batch by the page that
  already resolved them. Tiles in a `draft` batch stay inert — there is no job to open until
  approval cuts one — and now say so on the control itself rather than looking broken.

  The guard is the one the epic asked for: `frontend/app/cycle/cycle.spec.ts` reaches the
  annotator **entirely by clicking**, and the helper that used to fetch a job id out of the API so
  the spec could type a URL is deleted. Verified by mutation — disabling the tiles again, or
  ignoring the requested asset, each turns the walk red.

- **The export report said polygons were not carried while YOLO and VOC wrote them as bounding
  boxes** (#158). `Exporter.supported_geometries` carried one meaning and was read with two
  intents: the compatibility report treated an unsupported geometry as absent from the output,
  while both lossy exporters converted it and wrote it. A user was told three annotations would be
  lost, consented, and received two of them back as boxes under the polygon's own class name — well
  formed in every way a validator can check, and not what the report promised.

  `Exporter` gained **`degraded_geometries`** (`{polygon}` for `yolo` and `voc`, empty for `coco`
  and `dummy`), and `ClassCompatibility.supported: bool` became **`status`**, one of `supported` /
  `degraded` / `dropped`. `excluded_annotations` and `excluded_assets` now count **dropped only**,
  with `degraded_annotations` / `degraded_assets` beside them; every `reason` says what actually
  happens to that class. `compatible` is still false for either, so the `allow_lossy` gate did not
  move — only the accounting became true. `GET /formats` publishes `degraded_geometries`, and
  `visionset export` prints the two outcomes on separate lines.

  Shipped with the guard that was missing: `tests/formats/test_report_agreement.py` exports one
  release through **every installed format** and counts the annotations in the artifacts on disk,
  so a report that disagrees with its own output fails — and a fourth exporter either lands a
  counter there or is declared non-writing.

  **Breaking for API clients**: `ClassCompatibilityOut.supported` is replaced by `status`, and
  `ExportCompatibilityOut` gains two fields. Regenerate any generated client.

## [0.0.1b1] — 2026-07-31

The first published artifact: video in, a training dataset out, and nothing to install but a
wheel.

### Added

**Export formats.** Three real exporters, each declaring what it can carry.

- **YOLO** detection — `data.yaml`, one label file per image, images laid out per split. Classes
  come from the release's frozen schema rather than from the annotations present, so a class
  nobody has used yet keeps its index and a new one cannot renumber the others.
- **COCO** instances — boxes *and* polygon segmentation in one document, per split. Lossless:
  everything COCO has no field for (attributes, confidence, provenance) rides in a `visionset`
  object per annotation, so a release of boxes and polygons exports with no consent at all.
- **Pascal VOC** — one XML per image, folds as `ImageSets/Main/*.txt` listings. Coordinates are
  1-based and inclusive, which is what the format means.

**Export validation.** Before anything is written, VisionSet works out exactly what a format would
drop from a release — per class, with annotation and asset counts — and refuses to drop it
silently. The report travels three ways: attached to the refusal, carried on the result, and
written into the export directory as `visionset-export-report.json`. `check_export` /
`GET /releases/{id}/export-compatibility` ask the same question without writing.

**One wheel, with the app inside it.** `scripts/build_dist.sh` builds the frontend, copies it into
the package, and builds the distribution — in that order, which is enforced rather than
documented. `tests/packaging/` then checks the artifact rather than the source tree: the bundle is
in it, built for the right base, the entry points ship, the version metadata agrees, nothing
enormous came along, and a clean-venv install serves `/ui` for real.

**The thirty-minute flow, as a CI gate.** `examples/thirty_minute_flow.py` drives project → clip →
50 frames → 50 boxes → verified release → YOLO export → `ultralytics` loading the result. CI runs
it from the installed wheel in an empty environment, with every stage named and timed.

**Documentation for people who have not seen the repository.** A real quickstart, an
[install guide](docs/install.md), a [first-dataset tutorial](docs/tutorial.md), a
[release runbook](docs/releasing.md), and an MCP tool reference generated from the server's own
listing so it cannot drift from what an agent is told.

### Changed

- **The MCP server no longer advertises `delete_project` unless it was started with
  `--allow-destructive`.** Four measured agent runs sent `confirm: true` on the *first* call,
  having read the parameter in the tool description — so `confirm` is an instruction rather than a
  gate when the caller is a model. `confirm` itself is unchanged and still correct for every other
  surface; the change is only whether an agent is shown the tool. **33 tools by default.**
- `Exporter` gained `supported_geometries` / `supported_modalities`, and `export` takes a
  read-only content reader — a manifest's `uri` is where bytes were first *seen*, not a file
  anything can open.

### Fixed

- **A classification tag is now unique per `(asset, class)`**, enforced by a partial index
  (migration 12, `FORMAT_VERSION` 12). Nothing had enforced it: the service judged against the
  pinned schema alone and never read the store.
- A release naming bytes that are gone or will not decode now fails the export by name
  (`EXPORT_SOURCE_UNREADABLE`) instead of producing a training set quietly missing an image.

### Known limits

- Ingest and export are **synchronous** — there is no job to poll, and a long video is a long call.
- Video-derived asset identity is reproducible within one ffmpeg build, not across versions.
- `mask`, `polyline`, keypoints and 3D geometries are named in the domain and not implemented.
- A zoom in the annotator is O(annotations) — pan and drag hold 60fps over 220 shapes, a zoom does
  not (#131).

---

## Milestones

Each alpha is a git tag, never published. They are listed because the tree is bisectable across
them and the numbers say what each one cost.

| | | | |
| --- | --- | --- | --- |
| **M1** — the SDK | `v0.0.1-alpha.1` | 2026-07-27 | The kernel: workspaces, projects, schemas, batches, jobs, annotations, datasets, releases, events — hexagonal, framework-free, 13 issues |
| **M2** — ingest | `v0.0.1-alpha.2` | 2026-07-27 | Where assets come from: image and video sources, decomposition, content-addressed storage, thumbnails, 8 issues |
| **M3** — surfaces | `v0.0.1-alpha.3` | 2026-07-29 | The same kernel three ways: a 53-operation REST API with a committed OpenAPI contract, a full CLI, 33 MCP tools, 15 issues |
| **M4** — the annotator | `v0.0.1-alpha.4` | 2026-07-31 | A headless annotation engine and a React renderer over it: command store, geometry, interaction machine, bbox/polygon/tag tools, 14 issues |
| **M5** — the browser client | `v0.0.1-alpha.5` | 2026-07-31 | The product shell: design system, data layer, every screen, and a browser cycle test that drives a real server, 12 issues |
| **M6** — the beta | `v0.0.1-beta.1` | 2026-07-31 | Exporters, the wheel, and the thirty-minute flow as a gate, 11 issues |
| **beta.2** — the correction | `v0.0.1-beta.2` | 2026-07-31 | Five defects a manual pass over the wheel found, each with the guard that would have caught it, 6 issues |

[0.0.1b2]: https://github.com/Robomous/VisionSet/releases/tag/v0.0.1-beta.2
[0.0.1b1]: https://github.com/Robomous/VisionSet/releases/tag/v0.0.1-beta.1
