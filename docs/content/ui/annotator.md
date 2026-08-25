# The annotation workspace

The UX contract for the one screen somebody sits in for an hour. The data flow behind it —
queries, saving, review moves, the suggest tool's server side — is
[`docs/content/ui.md`](../ui.md); the kernel's rules for the labels themselves are
[`docs/content/annotations.md`](../annotations.md); the visual foundations are
[`DESIGN.md`](../../../DESIGN.md). This page describes the workspace as the current
implementation renders it, using the current implementation's token names.

## The workspace is self-sufficient

No flow may force navigation out of the editor, and no exit may lose work. Back saves
first; a class the schema lacks is created from the class list without leaving the page;
looking at the job's other frames is an **overlay, not an exit** — the grid button opens a
gallery over the workspace and the URL does not move. Every trip out of the editor is a
trip back through a list, a tab and a scroll position to the frame you were looking at,
which is why this rule is immovable.

## The top bar

One 44px row on `card` with a bottom hairline, 32px controls, in **three zones** — *where
you are*, *what changes the frame*, *the session*:

| Zone | Contents |
| --- | --- |
| Left | back · pinned `v{n}` badge · the frame's identity as a label (the content-hash head — there is no filename on the wire) · the frame microtext `● annotated · Saved` |
| Centre | the **navigation cluster**: `[⊞] [‹] n/m [›] │ [Skip] [Save and next] [Save and stay]` |
| Right | `n / m annotated` · the review move (outline) · overflow `⋯` |

**Everything that changes the picture on screen is in the centre cluster, and nothing else
is.** One hairline divider separates the two sub-groups — **browse | resolve** — so the
difference between *look at another frame* and *finish this one* is adjacency rather than
something learned. `‹` `›` browse: they move without settling progress, under the same
save-first guard as back and the gallery. `n/m` renders between them in tabular figures, so
walking a job does not shuffle the arrows under a cursor that has not moved.

**The centre is anchored on the bar's geometric centre** — the header is a `1fr auto 1fr`
grid — and the side tracks yield: a label truncates, never a control. Two widths inside the
cluster are pinned so it is the same size on every frame: the resolution pair's minimum
(covering `Skip` and `Un-skip`) and the flow verb's minimum (the widest of `Next` /
`Save and next` / `Finish job` / `Finished`). The readout that gives way is a readout:
`n / m annotated` truncates, and no button is ever clipped.

**The dominant slot is the flow verb.** After finishing a frame the right move is *this one
is done, show me the next* — the navigator's `›` is chrome rather than a verb. **Skip and
Save and next are siblings** — two ways to resolve this frame, skipped or annotated, both
advancing — and neither ever collapses into the overflow.

- `Save and next` is the same save-first advance the navigator uses, so there is one save
  pipeline and one place the no-lost-work rule is enforced. It reads **`Next` when no save
  will happen** — an untouched frame — because the button never promises a save it will not
  perform, and once the job is closed it is not rendered at all: there is no save-first
  advance to offer, and `›` is what moves there.
- **On the last frame `Finish job` takes the dominant slot**, in place: `Save and next` is
  not rendered there, and Finish job is not rendered anywhere else. Where it renders and
  cannot be pressed, it carries why. The consequence is worth stating: `complete` is
  reachable from the last frame only.
- **The review move is an outline control**, chosen from the frame's own `allowed_actions`:
  `submit_for_review`, else `accept` — mutually exclusive by construction. `complete` is
  deliberately not ranked against them: it is the *job's* action, and it co-declares with
  `submit_for_review` on the commonest path, so ranking them would hide Finish job exactly
  where most jobs end. Submitting carries a tooltip saying what it means, because this
  product has no annotator identity — a submitted frame is marked for a review pass, not
  routed to a person.
- **Save and stay is the second half of the forward gesture, and it sits beside the
  first** as the third member of the resolve group — `Skip · [flow verb] · Save and stay`.
  *Advance* and *persist in place* are one decision read two ways, so they are adjacent
  rather than a bar apart. In the current implementation the flow verb is filled in
  `primary` and Save and stay is filled in `success`; colour is what separates their
  intent, since a second `primary` beside the first would read as a bar that could not
  decide. It keeps the frame verbs' lifetime rather than the mode's: a closed batch or a
  finished job has nothing to save on any frame, so it leaves with Skip and the flow verb;
  inside a working job it holds its slot, disabled, so the cluster does not change width as
  somebody walks a mixed job.
- **Reabsorption order when the bar runs out of room**: Save and stay first (below `xl`),
  the review move second (below `lg`), into the overflow; the Skip/Save-and-next pair never
  collapses. Each reabsorbed control carries the exact inverse of its button's breakpoint,
  so it exists in exactly one place at any width.
- **Hotkey chips go on the ghost and outline controls and on nothing else** — `X` on Skip,
  from `core/input/bindings.ts`. A chip is a lighter-than-the-surface treatment: inside a
  filled control it inverts and reads as a smudge rather than as a key, so neither filled
  control carries one. `⌘S` is taught by Save and stay's tooltip — the tool strip's own
  pattern (`Box (B)`) — and `enter` is the one key with two meanings, the polygon ring
  close while a shape is in progress and *finish the frame* otherwise. Both are in the
  shortcut sheet, which derives its rows from the live binding registry rather than from a
  hand-written table.
- The bar carries the frame microtext `● annotated · Saved`, which says *where the work
  is*. The word is on the bar beside the save state because **status is never colour
  alone**, and a tooltip is a place a word goes to not be read. After a refused save the
  honest answer there is `unsaved`, and the reason is a sentence in the notice column.

## In-editor messages, and waits

**In-editor messages have one surface, top-right of the stage** (`EditorNotice`). Every
sentence the editor floats over the picture goes into one column inset 16px from the
stage's top and right edges: a suggest session, a refused save, a refused progress move,
and a batch or job that could not be opened. Top-right is the corner nothing else occupies:
the tool strip is top-left, the object counter bottom-left, the zoom cluster bottom-right.
The column is a stack, most-blocking first, because more than one of those can be true at
once. Its body wraps mid-token — a model reference is one unbroken string and no fixed
width guarantees the next one fits, so wrapping is the invariant and the width is comfort.

**A wait is reported as soon as it starts, and once reported it stays for at least 250ms.**
Work that has begun and shows nothing is the state in which *working* and *broken* look
alike, so the trigger is the request leaving. The floor is the asymmetry: appearing is
free, and disappearing after two frames is the glitch. Where a wait has a second threshold
worth crossing, what appears is **prose**, never a second indicator. The worked example is
the suggest tool: the panel says `Looking at that…` from the moment the request is
dispatched, and past 1.5s adds a sentence saying that the first click on a frame is the
slow one.

**A wait is reported in one place, and never at the cursor.** An indicator sitting on the
picture, next to the pointer, reads as the machine having *seized* rather than as work in
progress — it is in the way of the thing being looked at, and it moves with the hand. The
card is out of the way, says the same thing in words, and is where every other answer about
the tool already appears. **An indicator is never brand-coloured**: quiet neutrals, at low
opacity, at the place the person is already looking.

## The classes region

Class selection is a **list** in the side panel's upper region — what is being chosen
between is the ontology, and a list keeps all of it one click away, so *what can I draw
here* is always on screen. Rows carry swatch · name · geometry chips · hotkey badge, in the
**schema's authored order and only that**: a persistent list that reordered itself by
recency would move rows under the cursor, and the digits are schema positions. `c` focuses
its filter, Enter takes the first match, digits 1–9 activate directly, and the derived tool
follows the class. When nothing matches what was typed the last row is
`Create class "<text>"`, which opens the add-a-class dialog on that name; an empty schema
renders an invitation instead of an empty list. **It shows the drawing class and never
follows the selection** — re-classing an existing annotation is an object row's menu, a
different question about a different object. On a frame nothing can be drawn on, the list
still renders — which classes exist stays true there — with every row disabled *and
carrying why*.

**The drawing class's lifetime is the job**, not the frame: it survives moving to the next
asset, because somebody labelling one class across a clip picks it once, and it survives a
re-pin. It stops at the job's edge, the same scope the clipboard has and for the same
reason — a paste and a drawing class both belong to one pinned schema.

**Every row's shapes are chips, and every chip is a press target.** A class accepts a *set*
of geometries, so arming a class does not pick the shape by itself. One chip per
**drawable** geometry, labelled with the geometry **word** — glyphs are not
self-describing at chip size on the one row whose job is telling shapes apart. What a press
does depends on the row, and the two readings are one rule — *this class, this shape*:

- On the **armed** row the active chip is lit and pressing another switches the tool and
  **never the class** — changing shape must not move somebody's labels to a class they did
  not choose.
- On an **unarmed** row no chip is lit, and pressing one arms the class *with that shape*,
  in one press.
- Pressing the **name** arms the class with its first drawable shape.

The cost is that a row carrying chips is a `role="group"` with an inner name button rather
than one row-wide `<button>` — HTML forbids interactive descendants inside a button. A row
carrying a **refusal** never picks: it falls back to the plain button, the only one that
can be `disabled`, so the rule stays *explained and inert*.

Geometry words are **display labels, never wire values** — `box`, not `bbox`; `tag`, not
`classification_tag`. One map, `GEOMETRY_LABELS`, shared with the tool strip; lowercase,
because the same word is read as a chip in a row and inside a sentence.

**What gives way, stated: the row's height.** The chips wrap beneath the name and stay
right-aligned in the same column every unwrapped row's chips sit in, so a long name gets
the whole first line and the list keeps the one vertical edge it is scanned down.
Truncating a control is worse than truncating a label, and every chip is a control.

**A class that declares only `classification_tag` is not in this list at all.** It has no
canvas gesture; the Tags region is where it is assigned. It is also excluded from the count
the region's height rule reads.

## The side panel

A 288px column (320px from 1536px — headroom for a class naming three shapes, withheld
below that on purpose: the minimum supported viewport must not be charged for a width
chosen on a large monitor). `muted` surface, hairline border, 12px radius. **Three stacked
regions, no tabs and no splitter** — Classes, Tags, Annotations. A tab is a claim that
things are alternatives, and these are three answers about one frame, read top to bottom:
*what may I draw*, *what is true of the whole picture*, *what have I drawn*. All three are
on screen at once.

**A region with nothing to show is not rendered**, and its divider goes with it: no class
anything can be drawn with, or no class declaring a tag. A heading over an empty box is a
claim that something is missing. Annotations is the exception and always renders — an empty
frame is the normal state of a fresh one, and it says so in words.

**Classes (upper).** Header — the word `Classes`, the class count in muted meta, and a `+`
opening the add-a-class dialog; then a `Filter classes…` input; then the rows described
above. Its height is **content-driven and stated in rows**: a floor of 3 rows' worth, one
row per class after that, a ceiling of 8, after which the region is fixed and the list
scrolls inside it. The count it is computed from is the **schema's drawable classes**,
never the filtered ones — a height that tracked the filter would reflow the region below it
on every keystroke. The header and the filter are not rows and do not scroll away.

**Tags (middle).** Rendered only when the pinned schema declares a `classification_tag`
class. Header — the word `Tags` and the assigned count — then one line of meta prose,
`Tags apply to the whole image.`, which is the whole difference between this region and the
two around it. Then the chips: rounded-full, swatch, name, and either the hotkey digit or a
check; tinted with an accent border when assigned and outlined muted when not.
**Multi-select and unbounded**: an image carries one tag per tag-capable class and as many
classes as the schema declares, which is the kernel's own rule, so the chips enforce
nothing the kernel would contradict. The region has its own capped scroller, so thirty tag
classes cannot push the objects region off the panel. **No filter** — the lists rule is
about rows, and these are chips in a wrapping cloud, read at a glance; a third filter input
inside a 288px panel that already has two would cost more attention than it saves. Revisit
if a real schema arrives with enough tag classes to disprove it.

**Annotations (lower).** Takes all remaining height and scrolls independently, and holds
**drawn shapes only** — a tag has no coordinates, renders in neither canvas layer, and is
assigned in the region above; counting it here would give a tagged-but-undrawn frame
`1 object` and a hide button that hides nothing. Top to bottom: header (the word
`Annotations`, the object count, the all-visibility toggle); the filter — *always*
rendered, because a control that appears once a list is long enough is a control nobody
finds; then the object rows: meta-size `N. class`, selected = accent border + tint, hidden
= 50% opacity, per-row tag / eye / trash as small ghost icon buttons.

The split between the regions is a **hairline, not a handle** — a draggable splitter would
add per-user state to a surface whose whole value is being the same on every frame. The two
regions' selected treatments are deliberately different — a class row is a left accent rule
plus a tint, an object row is a full border — because they are selections of different
kinds of thing and a person reads both at once. **The object number is draw order and
filtering does not renumber it** — it is the object's identity on the canvas, and a panel
that renumbered as somebody typed would disagree with the picture about which shape is "3".

The per-row **tag icon** opens class reassignment: every class the schema declares, with
the ones whose geometry does not match this annotation disabled and **carrying the reason**
(`needs a polygon`). Listed-and-refused rather than filtered out: a short list with no
explanation reads as a schema missing its classes, and the rule — the kernel judges
geometry per class — is invisible exactly when somebody is hunting for the class that is
not there. Applied on selection, not behind an Apply, so there is no per-keystroke state to
keep out of the undo history. Each item that *can* be picked shows its class hotkey, and
pressing that digit while the menu is open reassigns; a disabled item spends the same slot
on the reason instead, because a key chip on a row that refuses the key is a lie.

**Class picker, second anchor**: the same menu, on the shape. With exactly one shape
selected a small tag button rides above its top-right corner — above rather than on it,
because that corner belongs to the resize grip — and a right-click on the shape opens it
there too, selecting the shape on the way. Same component, so the class list, the
disabled-with-reason rendering, the hotkeys and the apply are one spelling and cannot drift
between the two anchors. It is **absent**, not disabled, when the frame is read-only, when
nothing or more than one thing is selected, and for a classification tag, which the canvas
draws nowhere.

## The pinned version, and adding a class

**Pinned version badge.** `v{n}` in the left zone names the version *this batch is judged
against* — not the project's active one, since the pin is movable. Pressing it opens a
small panel that says whether that is still the current version and, when it is not, what
arrived since, in the kernel's own words for the change. Nothing about the active version
is fetched until it is opened: the editor is judged against the pin, and a page that read
the active version on arrival would be one refactor from offering classes the API then
refuses. A hand-built disclosure rather than a popover, because the annotator reads the
keyboard off its own root and focus has to come back to the canvas.

**Add-a-class dialog: one sitting is one published schema version.** `Create and add
another` (⌘↵) banks the class and clears the form; the primary publishes everything banked
plus whatever is still in the form. The banked classes show as chips that can be taken back
out, the auto-written description names them all, and the primary says how many it will
publish (`Add 3 classes`). Opened from the class list's create row it starts on the name
that was typed; opened from a `+` it starts empty, because that press means "I want a
class", not a particular one. **A name the published version already declares is an offer,
not an error**: the dialog says what that class accepts today and what publishing would
add, and the primary reads `Add polygon to "sign"`; it carries the existing class's colour
and attributes, so a form opened to make a new class cannot quietly overwrite what the old
one declared. A name typed twice in one sitting stays a refusal, because both are being
written now and merging them would be guessing. When it lands, the **last** class written
becomes the drawing class and a toast says so — a session publishes one version and arms
one class, neither of which anybody watched happen. Cancelling with classes banked
**asks**, on Escape and the overlay too: everything a session holds lives in the browser,
so closing loses exactly what was typed and nothing else. The save-then-publish-then-repin
order, the `canRepin` preflight that says *before* the press when a completed batch will
keep its version, and the refusal that names the Schema tab are all described in
[`docs/content/ui.md`](../ui.md).

**Version history grouping.** The project's Schema tab ends in a ledger of every version,
and the annotator publishes versions too, so consecutive versions whose `provenance` is
`annotation` collapse into one expandable row — `v3–v5`, how many, when the run ended, and
the contract it left behind — while `curated` versions (and those from before the field
existed) always render individually. A run of one is not a run. Expanding gives back
exactly the rows a flat table would have had, indented.

## The tool strip

Floating at the canvas's left edge — a 48px column on `muted`, hairline border, 12px
radius, 8px padding; 36px icon buttons; **active tool = the filled action treatment**,
inactive = ghost; a divider; help at the bottom. Tooltips open right with the shortcut
("Select (V)", "Box (B)", "Polygon (P)"). Only tools the schema's geometries allow — and,
**with a class selected, only that class's own**: offering a polygon button under a
boxes-only class would answer *what can I draw here* with a lie. With no class selected it
is the schema's union. Switching to a class that forbids the active tool never strands it —
the derived tool resolves to the class's first allowed shape — and the route to a different
class's geometry is the class list, which is where choosing a class belongs.

**Last of the tools, below the `+`, the hand** (`H`) — the one button the schema does not
gate, because it answers a question about the *device* rather than the project: a trackpad,
a tablet and a pen have no second button to offer for panning. Cursor `grab`, `grabbing`
while a drag is under way. **The hand and the derived tool are one lit button, not two**:
while the hand is on, no tool row reads as active, because the canvas answers a primary
press with a pan — and pressing any tool, or reaching for a class, puts the hand down.
**Suggest is not in that group**: it is a mode over the class it borrows, so it is
legitimately lit beside a tool and keeps its own state. While the hand is on there is no
crosshair and no highlighted grip, because both would be offers the canvas cannot keep.

Below a second divider, **undo and redo** — disabled *with the reason* (`Nothing to undo`)
rather than hidden, because an empty history is a state a person is in constantly, and a
control that vanished and reappeared as they worked would be worse than one that explains
itself.

The geometries with no tool behind them, `aria-disabled` rather than `disabled`, and the
suggest tool's whole flow are in [`docs/content/ui.md`](../ui.md).

## The frame gallery

The grid button opens the job's frames as a thumbnail overlay over the workspace — square
tiles with the photo-icon fallback, each carrying its frame number and its status dot, with
the **word** in the tile's accessible name and tooltip because a tile has no room for
prose. The current frame is marked and takes the focus on open, which is also what scrolls
it into view. Above the grid, the batch view's own four-segment filter
(`All / Unannotated / In review / Done`), counted over *this job's* frames. **One press
opens a frame** — no select-then-open — through the same save-first path `‹` / `›` use, so
a refused save keeps the work and the frame. Escape or the scrim returns to exactly the
frame, zoom, pan and armed class that were there. **No batch actions of any kind**: no
approve, no promote, no selection, no bulk bar. It is a switcher; the batch view stays the
home of batch operations.

## Zoom, pan, and the device model

**Zoom widget**: floating bottom-right of the stage, opposite the tool strip and sharing
its chrome — `− / readout / + / fit / fullscreen`. Zoom changes how the work is looked at,
not the work, which is why it is not in the top bar. Fullscreen is requested on the
**stage** element rather than the document, so the tool strip and the widget go with it,
and it is **absent rather than disabled** where the browser has no Fullscreen API — there
is no state a person could change to get it. **5%–800%**: an 8K frame does not fit a laptop
pane above about 18%, so a higher floor makes "zoom out until you can see the whole thing"
unreachable; the ceiling is where one asset pixel is an eight-pixel block and the picture
has nothing further to show — above 4x the image renders `image-rendering: pixelated`, so
depth shows real pixel blocks rather than interpolated blur. Both bounds are **disabled
with the reason** — `aria-disabled` and a tooltip naming the limit, never a press that
silently does nothing.

**Navigating the picture is one model across every device.** Pan: a two-finger trackpad
scroll, a middle- or right-button drag, `Space` held with any drag, or the hand tool. Zoom:
a mouse wheel, a trackpad pinch, `Ctrl`/`Cmd` with a scroll, the widget's `−`/`+`, and
`mod+0` to fit. On a touchscreen one finger draws — or pans while the hand is on — and two
fingers pinch and drag together. **A bare wheel event is answered by device**: a two-finger
scroll pans, a wheel notch zooms.

**Where one event cannot name the device, assume the mouse and make the trackpad prove
itself.** A high-resolution wheel reports a fraction of a detent, which is the shape a
trackpad reports on the same axis in the same units, so no arithmetic on a single event
separates them. The evidence that does is **travel on both axes at once**, which drifting
fingers produce constantly and no wheel can produce at all — reading the horizontal axis
*alone* would condemn a mouse for a nudge of its own thumb wheel. The burden of proof sits
this way round because the mistakes are different sizes: a wrongly-assumed mouse costs a
trackpad one gesture before it corrects itself, while a wrongly-assumed trackpad costs a
mouse its zoom **permanently**, since a wheel emits nothing that could overturn the guess.
The sighting is persisted per browser, so a trackpad pays that gesture once. **There is no
setting for this** — an inference that is right without being asked does not need a
control. The shortcut sheet's Navigate section is the one place this is written for a user,
hand-written rather than derived, because a gesture has no chord to be read off.

## The read-only mode

The workspace opens as a **viewer** whenever the wire withholds `annotate` on the frame — a
completed batch, a finished job, or a settled frame inside an open one. The mode is the
frame's own declaration (`allowed_actions`), never this page's arithmetic.

**It is also a transition, not only an entry state.** Pressing `Finish job` turns the
workspace into a viewer **in place** — same window, no navigation, no reload — across every
frame of the job: the mutation invalidates the frames' declarations and the page
re-derives. The press says so out loud with a toast, because everything else it does is a
subtraction, and a screen with less on it is not an explanation.

What a viewer is:

- **One explanation surface.** The banner under the top bar says `Viewing only.` with the
  cause, and — when the wire declares `create_correction` — the route onward:
  `Correct this batch`. It renders on every frame of a closed batch or a finished job,
  including skipped ones, where the skipped notice would otherwise promise an Un-skip the
  wire withholds. Three causes, three sentences, ranked: a closed batch carries the
  correction route; a finished job names itself and offers nothing, because the job model
  has no way back and the batch is still open; a settled frame in an open batch points at
  the control on this very toolbar.
- **No classes region.** The side panel is the objects region alone, at full height — the
  region, its filter, its quick-create and its hotkey badges are absent, not disabled, and
  `C` and the digits do nothing. *What may I draw* is not a question a viewer can ask.
- **Selection highlights; it does not advertise.** A selected shape renders the selected
  treatment — stroke 3, the label — with no grips and no vertex dots, and the cursor is the
  default arrow everywhere: no resize keywords, because no such gesture exists.
- **The tool strip renders, carrying navigation and nothing else.** The hand is not a
  drawing tool — it is what a person reaches for when the picture is in the wrong place —
  and navigating a batch nobody may edit is most of what a viewer does, so the strip keeps
  the hand and the shortcut sheet and loses every other button.
- **Selection is one state, reflected everywhere.** A press on a shape selects it, and the
  objects panel's row highlights and scrolls into view. DOM focus stays with the canvas,
  which reads its chords off its own root.
- **Once the job is closed, the frame's own verbs go with it — and the job's does not.**
  `Skip` / `Un-skip` and the flow verb stop rendering on every frame of a completed batch
  or a finished job, along with the browse | resolve divider. **The gate is the job, never
  the frame**, and both halves are load-bearing: a merely *settled* frame inside a working
  job keeps the pair, greyed — the cluster is measured to one width, and `Un-skip` is the
  one way back out of a skipped frame — while a closed job withholds every move on every
  frame alike, so the cluster is uniformly narrower and nothing jitters. `Finish job` stays
  on the last frame: `complete` is the *job's* declaration, and a job whose last frame
  happens to be `accepted` would otherwise have no way to be finished. Once finished it
  reads `Finished`, the page's standing statement that the work is over.
- **Navigation stays whole.** `‹` `›`, the counter and the frame gallery all work, and no
  save-first guard engages — there is nothing to save.
- **Reads stay live.** Zoom, pan, fullscreen, visibility toggles, the object filter, and
  copy — the road a box takes into a correction batch — all work; paste and every other
  write is refused at the engine (`readOnly` on the canvas, `READ_ONLY_KINDS` for the
  keyboard).

## The stage

The area around the asset is the **`stage`** token, never `muted` and never a dark surface.
It is a role of its own for two reasons: a dark surround shifts the perceived contrast and
colour of the photograph inside it, which is a real cost on a tool whose whole job is
looking closely at pixels — and a lone dark surface would make the one screen somebody sits
in front of for an hour read as a different application.

It must stay distinguishable from the page background as well as from the image: an asset
with white borders has to show where it ends. The e2e suite asserts the contrast gap rather
than the hex. `stage` is a VisionSet-specific semantic token and is recorded as such in
[`DESIGN.md`](../../../DESIGN.md).

## Shape rendering

One class-colour rule shared by the canvas, the side panel swatches, and the gallery
badges: `classColor` in `frontend/annotator/src/adapters/react/paint.ts`. `ui-core`
**imports it**; nothing respells it.

- A class **with a schema colour** uses it. Fill is the same colour at an opacity the shape
  applies — alpha is never baked in, because the kernel accepts any CSS colour spelling.
- A class **without one** falls back to a deterministic FNV-1a hash of the name →
  `hsl(hash % 360 72% 58%)` — stable per class, per session, per machine, with no palette
  prop to thread down.
- A control that can only take `#rrggbb` — `<input type="color">` in the schema editor —
  shows the same answer **converted**, never a substitute. `hexColor` in
  `frontend/ui-core/src/palette.ts` changes the notation and nothing else; it returns
  `null` for a CSS spelling it cannot convert, and the caller shows a neutral for that case
  alone.
- Shape metrics: stroke width 2, selected 3; vertices render while selected or while the
  shape is a suggestion preview, radius 5 (7 when the vertex itself is selected), with a
  2px white outline; the class label renders only while selected, 11px / 700, anchored at
  the first vertex, never a pointer target.

**The suggestion preview is a third visual state, not a shape marked selected.** Selection
carries the panel row, the delete key and the keyboard rules a proposal must not have. Its
vertices are up the whole time it is on screen, undecimated at every tolerance change, because
where precision was gained or lost *is* what the tolerance control is about. Its outline is
dashed and an accepted annotation's is solid, which is what tells proposed from committed
at a glance.

**The cursor promises the common outcome, not the rare one.** In Select mode, hovering a
shape — its body, its edge band, or a vertex — is the plain arrow: a press there *selects*,
and only becomes a move if the pointer then travels. What reports which shape a press would
take is the hover **highlight**, not the cursor. The four-arrow `move` appears only while a
drag is actually in flight, and the directional resize keywords only on a selected box's
grips, where they name an axis the arrow cannot.

**The canvas label is part of what selection looks like.** A frame carrying forty boxes
must not draw forty class names over the picture — that hides the asset behind the
annotations of it. The panel is the full inventory; the canvas answers *what is this one*
for the shape somebody picked, and an unselected shape is its box alone.

**A model's work is marked; a person's is not.** `provenance: "model"` earns a sparkles
glyph on the side-panel row, whose accessible name carries the claim in words and whose
tooltip carries the full `model_ref`. That glyph is the *only* provenance signal in the
editor. Never colour alone — class colour is already user data and cannot also mean
provenance. **Absence is the human case**: no "manual" badge, no mark on the common path,
because the row a reviewer sees a thousand times is the one that must stay quiet. `import`
provenance is unmarked until there is an importer whose mark would mean something.

**Confidence renders on the live suggestion preview and nowhere else in the editor.** The
number tells somebody whether to accept a proposal; once accepted, the shape is a label
like any other and the score is decoration on every subsequent reading of it. It is not
discarded — `confidence` and `model_ref` are stored unchanged — and its home is the batch
review loop, where a surface showing it must also name *what it measures*: a point-prompted
mask score and a detection's prompt affinity are different quantities on different scales
and cannot be pooled, thresholded or sorted together. **Where it is shown, it has one
spelling, and that is whole percent**: `confidencePercent` in
`frontend/annotator/src/adapters/react/paint.ts` — whoever shows the number imports it,
because two notations for one quantity is a number that disagrees with itself. A `null`
confidence reads as absent — never as `0`, never as a low score.
