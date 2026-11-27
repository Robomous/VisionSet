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
looking at the job's other frames is an **overlay, not an exit** — the island's frame button opens a
gallery over the workspace and the URL does not move. Every trip out of the editor is a
trip back through a list, a tab and a scroll position to the frame you were looking at,
which is why this rule is immovable.

## The layout

**Three fixed zones under one bar, and one island on the picture.** A 48px bar runs the full
width; under it, the tool rail on the left, the stage in the middle, and the panel on the
right, full height. The moves made on every frame float over the stage in one island under
the hand. Nothing in a zone changes position from frame to frame.

| Zone | Contents |
| --- | --- |
| Bar | back (heading the rail's column) · the batch's name `›` `Job · n frames` (`Job · n scans` for a job of scans) · pinned `v{n}` badge — then, at the far end, the job's progress · a hairline · the save state · the frame's review move · overflow `⋯` |
| Rail | the tools, the hand; at the foot, hide/show all objects, then help. Absent on a scan, whose column the stage takes |
| Stage | the tool's own bar (the active tool and the class it draws; while Suggest is armed, its options and its state) over the picture, on an image only; on the picture, the status tag and under it the object count and hint top-left, notices top-right, the island bottom-centre, zoom bottom-right |
| Panel | the classes, tags and objects |

**The bar says where you are and where the work stands, and nothing on it moves between
frames.** The breadcrumb truncates before anything on the right gives way. Below a 56rem bar
(the 768 px viewport floor) the progress drops its bar and keeps `settled / total`, and the save
state keeps its icon and drops its word, except `Not saved`; both stay full in the
accessible name.

- **The job's progress is shown here and nowhere else**: a slim bar split by frame state —
  one segment per state, in the same tokens as the Overview's timeline cells
  (`progressCellClass`), easing to their new widths — beside `settled / total` in tabular
  figures. *Settled* is the product's own word, `SETTLED_PROGRESS` (annotated, skipped,
  accepted): the total less `outstandingWork`, so it never goes backwards when a frame is
  accepted. The settled number rolls in from below when it changes (220ms; a fade under
  reduced motion). Hovering or focusing it opens every state counted — dot, word, count and
  share — with a mini bar and how many frames still need a person. There is no key that jumps
  to the next such frame, so the card names none.
- **The save state says where the work is, without a tooltip** — `Edited`, `Saving`, `Saved`,
  or, after a refusal, `Not saved` in the `warning` tone. A cloud that fills in as the change
  lands: the four icons are all mounted and crossfade (opacity, scale from 0.25, blur from
  4px; 200ms on the strong ease-in-out), and the four words share one grid cell, so its width
  never changes. It is a live `status`. *Why* a save was refused is a sentence in the notice
  column, never here. The page saves on its own — see [`ui.md`](../ui.md#saving) — so there
  is no Save button; `⌘S` saves at once.
- **The review move is one outline control**, chosen from the frame's own `allowed_actions`:
  `submit_for_review`, else `accept` — mutually exclusive by construction. When the wire
  declares neither it stays, **disabled with its reason** (`Label this frame first`, `confirm
  them first, with the check on the frame's tag`, the closed batch's sentence), because a slot
  that came and went frame by frame would move the save state under the pointer; which of the
  two words it shows then is copy, and whether it can be pressed is `declares` alone.
  `complete` is deliberately not ranked against them: it is the *job's* action, and it
  co-declares with `submit_for_review` on the commonest path, so ranking them would hide
  Finish job exactly where most jobs end. Submitting carries a tooltip saying what it means,
  because this product has no annotator identity — a submitted frame is marked for a review
  pass, not routed to a person. `Confirm labels` is not on the bar: it is on the status tag.

**The island holds the moves made on every frame**, bottom-centre over the picture:
`[undo] [redo] | [Skip X] | [‹] [⊞ n / m] | [Next ↵]`. It is one `toolbar`, `rounded-xl` on
`background` at 95% with a blur and a layered hairline-and-shadow lift, its controls 36px and
`rounded-lg` inside a 4px inset. Like the rail's buttons, none of them takes the focus on
press, so the canvas keeps the keyboard.

- **`Next` is the page's one filled control**, and it always reads `Next`. It is the
  save-first advance — the same path `‹`, the gallery and back take — so there is one save
  pipeline and one place the no-lost-work rule is enforced; it waits behind a save already out
  rather than being disabled by it. It carries its key, `↵`, drawn in the fill's own foreground
  at 15% — a muted chip inverts into a smudge on a filled ground. There is no `›`: Next is the
  forward move, and back is only an icon because it is the rarer one.
- **On the last frame `Finish job` takes Next's slot**, in place, and is not rendered anywhere
  else. Where it renders and cannot be pressed on an editable page, it carries why
  (`aria-disabled` and a tooltip). On a read-only page it is natively `disabled`, and the same
  tooltip moves to a focusable wrapper around it, so the reason is still read on hover and on
  keyboard focus. `complete` is reachable from the last frame only.
- **`⊞ n / m` is which frame, and the way into all of them**: it opens the frame gallery, in
  tabular figures so walking a job does not shuffle the arrows under a cursor that has not
  moved.
- **Skip** (`X`) — **Un-skip** in its place on a skipped frame — is gated on the wire's
  declaration and, where the wire withholds it, disabled *with the reason*; its keycap shows
  only while the move is live. Skip and Un-skip keep the frame verbs' lifetime rather than the
  mode's: a closed batch or a finished job has nothing to skip on any frame, so they leave.
- **Undo and redo** are disabled with the reason (`Nothing to undo`) rather than hidden,
  because an empty history is a state a person is in constantly. They keep the frame verbs'
  lifetime: on a settled frame inside an open job they stay, withheld (`Viewing only`), so the
  island keeps its shape as the job is walked — Skip and Un-skip share one width, and so do
  Next and Finish job, for the same reason — and once the whole job is closed they leave with
  Skip.
- **Autosave says when a gesture is holding it**: once the wait is up while a drag, an open
  polygon or a pending suggestion is in progress, the save state carries
  `data-autosave="held"`, and the save goes the moment the gesture ends. A scan's labels are
  autosaved the same way: the frame keeps both documents, the wait restarts on a change to
  either, one plan carries both, and a box or polyline being drawn or a drag in the scan's
  editor holds the save as a drag on the picture does.
- **The save state claims a save only after one**: it is absent on a frame that has only been
  looked at, and appears once this visit has unsaved work or has saved.
- **Where the picture is too narrow for the island and the zoom widget side by side** (a
  52rem stage), the zoom widget rises above the island instead, and below 36rem the island
  drops its keycaps — so the two never overlap down to the editor's minimum viewport.
- **On a scan the view's own controls** (colour by, labels, reset view) take the zoom widget's
  place, in one bottom row with the island: the island centred, the controls in the row's
  right-hand cell, the island moving left of centre before the two would touch, and below a
  50rem stage the controls stacked above the island at the right. Neither is drawn over the
  other in View or in Edit, and in Edit the top-down view keeps its foot clear for that row
  (one row's height, two below 50rem), so no handle there sits under either.

**The status tag says which frame and where it stands**, top-left on the picture: the
content-hash head (there is no filename on the wire), the progress word beside its dot —
**status is never colour alone** — and, when a model wrote any of the frame's labels, `N from
the model`. While the wire declares `confirm`, the tag carries the move that keeps them: an
attached check (`CheckCheck` in `primary`, behind a hairline) named `Confirm labels`, beside
the word that says where the labels came from. Under the tag, the object count and **the
hint**, which says what the next press does with the active tool — `Drag to draw a box`,
`Click an object to suggest its outline` — and names only live bindings, each as a keycap. A
viewer gets no hint; the banner is that frame's one explanation.

**A key is drawn one way, as a `Kbd` keycap** — on Skip (`X`), on the tag chips and in the
hint; the hotkey goes on ghost and outline controls, from `core/input/bindings.ts` — and Next
carries `↵` in its own colours. `enter` is the one key with two meanings: the polygon ring
close while a shape is in progress, and *next frame* otherwise. Both are in the shortcut
sheet, which derives its rows from the live binding registry. There is no binding for `←` /
`→` between frames.

## In-editor messages, and waits

**In-editor messages have one surface, top-right of the stage** (`EditorNotice`). Every
sentence the editor floats over the picture goes into one column inset 16px from the
stage's top and right edges: a refused save, a refused progress move, and a batch or job
that could not be opened. **The suggest tool is not in that column**: what it is doing,
why it cannot, and its options are the tool's own, so they are said in the tool's bar
above the picture (*The tool strip*, below) and never over the thing being outlined. Top-right is the corner nothing else occupies:
the status tag and the hint are top-left, the island bottom-centre, the zoom cluster
bottom-right. The tag, the hint and the zoom cluster are one chrome — `background` at 95%
with a blur, lifted by a hairline and a small shadow (pure black; in dark, a pure white
hairline), never an outline — and the island takes the same lift a step deeper.
The column is a stack, most-blocking first, because more than one of those can be true at
once. Its body wraps mid-token — a model reference is one unbroken string and no fixed
width guarantees the next one fits, so wrapping is the invariant and the width is comfort.

**A wait is reported as soon as it starts, and once reported it stays for at least 250ms.**
Work that has begun and shows nothing is the state in which *working* and *broken* look
alike, so the trigger is the request leaving. The floor is the asymmetry: appearing is
free, and disappearing after two frames is the glitch. Where a wait has a second threshold
worth crossing, what appears is **prose**, never a second indicator. The worked example is
the suggest tool: its bar says `Looking at that…` from the moment the request is
dispatched, and past 1.5s an ⓘ appears beside it whose card says that the first click on a
frame is the slow one.

**A wait is reported in one place, and never at the cursor.** An indicator sitting on the
picture, next to the pointer, reads as the machine having *seized* rather than as work in
progress — it is in the way of the thing being looked at, and it moves with the hand. The
tool's bar is out of the way, says the same thing in words, and is where every other answer
about the tool already appears. **An indicator is never brand-coloured**: quiet neutrals, at low
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

The whole of the right column, full height, which is 288px (320px from 1536px — headroom for a class
naming three shapes, withheld below that on purpose: the minimum supported viewport must
not be charged for a width chosen on a large monitor). Flush with the column on `card`;
moving between frames and settling one are the island's and the bar's, not this column's. **Three stacked
regions, no tabs and no splitter** — Classes, Tags, Annotations. A tab is a claim that
things are alternatives, and these are three answers about one frame, read top to bottom:
*what may I draw*, *what is true of the whole picture*, *what have I drawn*. All three are
on screen at once. On a frame of a sequence source a fourth, Tracks, sits under them: it answers a
question about the sequence rather than the frame, *what follows this object from frame to frame*.

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
`Objects` and the object count — hiding every object is the rail's hide/show-all button at
its foot, which writes the same hidden set the rows' eyes do, so there is one such control
and nothing to keep in step); the filter — *always*
rendered, because a control that appears once a list is long enough is a control nobody
finds; then the object rows. A row reads `[swatch class ⌄] [values] [•] [✦] … #N [eye] [trash]`:
the class name at the class rows' size, then a muted, truncating summary of the object's
values (a select's, number's or string's value; a boolean by its name when it is true; the
shape's name too, where the class accepts more than one geometry and so the class alone does
not tell two rows apart), then a small warning dot when a required attribute has no value,
then the model mark, and the object's number at the end. Selected = accent border + tint,
hidden = 50% opacity. The whole row is the select target; the class name, the mark and the
two icons sit on it as controls of their own. Selecting from a row does not take keyboard focus:
the press leaves focus where it was, and if it was outside the canvas it moves to the canvas,
which reads its chords off its own root, so Delete and the other keys act on the selection. Eye and trash show on hover, on keyboard focus
inside the row and on the selected row — a column of icons per object was the loudest thing
in the list — and always where there is no hover; a hidden object's eye never hides, since it
is the only sign the object is there. Every row, heading and swatch in the panel starts on
one inset.

**The selected row opens its attributes.** When the selected object's class declares
attributes, their controls open beneath the row — a label column and the control, one line
each, with the booleans as a wrap of chips on the control column — rising in over 200 ms
(none under reduced motion; closing is a selection change and never waits on it). A select
with four options or fewer is a segmented radiogroup, and pressing the chosen option again
clears it; with more it is a select reading *Choose*, with a clear button beside it once it
holds a value. A number or a string is a compact field that commits on blur or Enter and
reverts on Escape — a number that does not parse is shown invalid and never written, and an
emptied field clears the attribute. A boolean is a chip that says its own name: on writes
`true`, off writes `false`, because the kernel reads *required* as a key being present and a
boolean somebody switched off has been answered. Clearing removes the key. Every change is
`replaceAnnotationCommand` with the new attributes — one change, one undo step, exactly like a
reassignment — and a field's draft is committed even when a press on the canvas closes the row
before the field could blur. Read-only renders the same controls, disabled.

**Required is information.** The dot beside a row and beside an attribute's name (*Needs a
value* on hover, and as its accessible name) says a required attribute is empty. Nothing is
disabled or refused because of it, and a required value can be cleared like any other — the
rule is the kernel's (`MissingRequiredAttribute`, on save), and a client that enforced it would
be a second spelling of it.

**Vertices, under the object rows, while exactly one polyline is selected.** A vertex has no
selection of its own and every canvas gesture on one is already taken, so this is where a
vertex is marked occluded. Header — the word `Vertices` and the occluded count, with
`, N unlabeled` appended only when a vertex is recorded `unlabeled`, or `Not recorded` while
the lane carries no visibility — then one toggle per vertex, numbered in point order, on a
five-column grid of equal cells so three-digit numbers line up, inside a scroller capped at
about eight rows. A toggle is pressed (`aria-pressed`) when occluded and stays binary; an
`unlabeled` vertex is unpressed like a visible one but carries a question-mark glyph, muted
ink, and `(unlabeled)` in its accessible name, so the two never read the same. Each press is
one undoable edit, and the one-line hint above the grid says so.

The toggles are **one `toolbar` with a roving tab stop**: Tab enters on the last toggle used
and leaves in one press however long the lane is; Left and Right step one vertex, Up and
Down one row, Home and End jump to the ends; Space or Enter toggles. Hovering or focusing a
toggle **rings that vertex on the canvas and writes its number beside it** — the store's
`highlightedVertex`, beside the selection and outside the history — which is how "vertex 23"
is found on a lane. Only the pointed-at vertex is numbered: forty numbers over the picture
would hide the lane they label. Ctrl/⌘+Z and Shift+Ctrl/⌘+Z on a focused toggle undo and
redo; see the keyboard note under the pinned version badge.

In the read-only mode the toggles stay, **disabled rather than hidden** — `aria-disabled`,
so they keep the tab stop, the arrows and the canvas highlight — and the hint goes, because
nothing can be pressed: what is recorded is still worth reading there.

**Unknown stays unknown until somebody says.** A polyline loaded without `visibility` holds it
as unknown, and saving it untouched sends no `visibility` key — so nothing is written that
nobody judged. The first toggle is a judgement of the whole lane, and records the whole list:
the pressed vertex `occluded`, every other vertex `visible`. The person pressing it is looking
at the lane drawn over the image, and leaving a vertex unpressed is saying it is seen — the
same reading a newly drawn polyline gets. Clearing a mark records `visible` too. The annotator
therefore never writes `unlabeled`; a state that arrived from elsewhere (an import, an agent)
is kept as it is until somebody presses that vertex.
A newly drawn polyline records every vertex `visible`. Edits keep the list aligned with the
points: a moved lane or vertex keeps it, an inserted vertex takes the state of the vertex
before it — so a vertex added inside an occluded run stays occluded — and a deleted vertex
takes its own state with it.

**Tracks (bottom), on a frame of a sequence source.** A [track](../annotations.md#a-track-observes-annotations-an-annotation-knows-nothing-of-tracks)
follows one object through the frame occurrences of one video or image-sequence source, so the
region renders only when the frame has a source and that source has occurrences; a folder's
frame, a scan and an upload with no source have none, and ask nothing about tracks. A read that
fails says so in the region's place, with *Try again*; a later reread that fails says so under the
tracks it still shows. Header — the word `Tracks`, the count, and a
`+` that starts a track from the selected object; then one row per track of the source in creation
order, inside a scroller capped at about four rows: swatch, the track's name (its class and its
imported id, else `#n` in creation order — a track has no name of its own), `here` when it observes
this frame, and how many frames it observes. Pressing a row follows that track: a left accent rule
and a tint, as a class row, because both are a choice of what to work with rather than a thing on
the picture. Following is held above the frame, so it survives moving between frames.

The followed track opens beneath the list: its standing in this batch in a line
(`3 of 4 settled in this batch · 2 outside it`, from `GET /tracks/{id}/status`, derived on every
read), `‹` and `›` either side of where it is on this frame (`On this frame at 12`), then the writes.
**A step opens the asset of the track's previous or next observation, through the same save-first
path as Next**, and only an asset this job carries: observations on assets another job holds — the
rest of a sequence a correction batch did not take — are passed over, and the frame it lands on says
`Passed over 2 frames outside this job.` Where nothing in the job lies that way the arrow stays,
disabled with its reason (`No later frame on this track`, or `Every later frame of this track is
outside this job (3)`). Gaps need nothing: a track ends where its observations end and reappears at
the next one. A frame whose bytes repeat at two positions is one asset at two occurrences, so the
position last stepped to is what tells the two apart.

**Two writes, both a job's, both the kernel's to judge.** *Add selected object* observes the one
selected drawn object at this frame, and *Remove from track* takes the track's observation here away
— the object stays, as the kernel keeps it. The `+` creates a track of the object's class and
observes the object with it; a refused observe leaves the new track listed, empty, and says so.
Adding and starting save first, so an object drawn a moment ago is stored before a track names it,
and a refused save stops there with its own notice; removing names only the occurrence and needs no
save. What a write came to is held above the frame, so one that lands after a step is still said. Where this frame is several positions of its source, a write
asks which (`At frame 4`). Every write is gated on the frame declaring `annotate` and is otherwise
withheld with its reason: `Viewing only`, `Select one drawn object to add it`, `That object is
already on car 7`, `The track already follows an object on this frame`. An object of another class
is listed-and-refused, as the reassignment menu refuses a geometry: `This track follows “car”`.
What only the kernel can know — a model's labels nobody has judged yet (`ASSET_NOT_JUDGED`), an
asset another job carries — is its refusal, rendered under the region as prose from the one
vocabulary; what landed is said there too (`Added at frame 4`). Merging, splitting, changing a
track's class and deleting a track are not offered in the editor.

**An observed object's row carries a track badge** (`Route`), after the model mark: its name and
position on hover (`On track car 7 at frame 12`), and a press follows that track. The badge is keyed
by the annotation the kernel stored, so **a pasted copy is on no track** — paste mints a fresh id,
which no observation names — and copy and paste are otherwise untouched by tracking. Changing the
class of an observed object from its row is refused at save (`TRACK_CLASS_MISMATCH`), because a
track's objects carry its class; deleting one deletes its observation, and the region rereads.

The split between the regions is a **hairline, not a handle** — a draggable splitter would
add per-user state to a surface whose whole value is being the same on every frame. The two
regions' selected treatments are deliberately different — a class row is a left accent rule
plus a tint, an object row is a full border — because they are selections of different
kinds of thing and a person reads both at once. **The object number is draw order and
filtering does not renumber it** — it is the object's identity on the canvas, and a panel
that renumbered as somebody typed would disagree with the picture about which shape is "3".

The row's **class name** is the reassignment control — the name and a small chevron, never an
icon beside it, because what the menu changes is what the name says. Pressing it opens the
menu without selecting the row. The menu lists every class the schema declares, with
the ones whose geometry does not match this annotation disabled and **carrying the reason**
(`needs a polygon`). Listed-and-refused rather than filtered out: a short list with no
explanation reads as a schema missing its classes, and the rule — the kernel judges
geometry per class — is invisible exactly when somebody is hunting for the class that is
not there. Applied on selection, not behind an Apply, so there is no per-keystroke state to
keep out of the undo history. Each item that *can* be picked shows its class hotkey, and
pressing that digit while the menu is open reassigns; a disabled item spends the same slot
on the reason instead, because a key chip on a row that refuses the key is a lie.

A reassignment also reconciles the object's attributes, at both anchors, in the same undo
step (`reassignedAnnotation` in the annotator core, next to the seeding a drawn object gets):
a value for an attribute the new class also declares is kept when it still fits — its kind,
and for a select one of the new options — every other declared attribute takes the new
class's default, and keys the new class does not declare are dropped, because the kernel
refuses them on save (`UnknownAttribute`).

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
keyboard off its own root and focus has to come back to the canvas. The one forwarding
exception is the Vertices toolbar: a person marking vertices from the keyboard is working
the document from there, so its toggles answer the undo and redo chords themselves, with the
same bindings and the same read-only refusal. Nothing else in the panel does — a chord in
the filter field stays the field's.

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
keep its version, and the refusal that names the Classes section are all described in
[`docs/content/ui.md`](../ui.md).

**Version history grouping.** The History sheet of the project's Classes section lists every
version, newest first, and the annotator publishes versions too, so consecutive versions whose
`provenance` is `annotation` are drawn on a lane of their own that branches off the main one and
rejoins it — one detour per sitting, in its own colour — while `curated` versions (and those from
before the field existed) stay on the main lane. A run of one is not a run. Every version keeps
its own line, so nothing is hidden behind a disclosure; a version opened from a run names the
sitting it came from.

## The tool strip

The rail — a fixed 48px column on `card` beside the stage, under the back arrow; 36px icon
buttons; **active tool = a surface step** (`muted` with a hairline ring), inactive = ghost —
never a fill, because the island's Next is the page's one filled control. The showcase
still floats the same strip over its canvas (`layout="floating"`). Tooltips open right with
the shortcut ("Select (V)", "Box (B)", "Polygon (P)"). Only tools the schema's geometries
allow — and, **with a class selected, only that class's own**: offering a polygon button
under a boxes-only class would answer *what can I draw here* with a lie. With no class
selected it is the schema's union. A `mask` class can be declared, and the strip lists a disabled
Mask button carrying the reason, because the annotator has no tool to draw or edit one; stored masks
are kept as they are. Switching to a class that forbids the active tool never
strands it — the derived tool resolves to the class's first allowed shape — and the route to
a different class's geometry is the class list, which is where choosing a class belongs.
**The rail picks how to draw; it does not add classes** — a class is added from the panel's
class region (its `+`, or the create row a filter with no match offers).

**Last of the tools, the hand** (`H`) — the one button the schema does not gate, because it
answers a question about the *device* rather than the project: a trackpad, a tablet and a
pen have no second button to offer for panning. Cursor `grab`, `grabbing` while a drag is
under way. **The hand and the derived tool are one lit button, not two**: while the hand is
on, no tool row reads as active, because the canvas answers a primary press with a pan — and
pressing any tool, or reaching for a class, puts the hand down. **Suggest is not in that
group**: it is a mode over the class it borrows, so it is legitimately lit beside a tool and
keeps its own state. While the hand is on there is no crosshair and no highlighted grip,
because both would be offers the canvas cannot keep.

**While Suggest is armed, the tool's bar carries its options and its state**, in one row:
where the click runs (`Server | Local`, a radio group, shown only once a browser runtime is
wired), the model answering (its name, or a picker once there are two; Local's model with
Download and its size, `Downloading…`, `Loading…` or `Ready`, and Remove in a small menu on
its name), the state in a few words — `Click the thing you want`, `Looking at that…`,
`Proposed shape`, `Nothing to suggest there`, `Suggestion refused`, `No model connection`,
`“lane” cannot hold a suggestion`, and for a detection `Detecting…`, `Nothing detected` or
`N of M chosen` (a button that opens the list of candidates) — with an ⓘ whose card holds the full explanation word for
word (a server refusal quoted exactly, because it carries the remedy) and is also the
button's description, the way out where there is one (`Set up`, `Put the tool away`), then
*Detect all* on Server while nothing is pending (disabled, with its reason as its
description, where no ready text-detection connection draws a shape the class holds; absent
on Local), `Box | Polygon` for a class that admits both, Detail once the answer declares it,
and the class; Accept `↵` (`Accept N` over a detection, disabled with none chosen) and
Discard `Esc` sit at the bar's far end while a proposal is shown (below 48rem Discard keeps
only its `X`).
Where the click runs, the model and the shape are drawn only while nothing is pending. The
bar is a size container: below 48rem of bar its words drop and its icons stay (each control
keeps its name), and what still does not fit scrolls inside the row with no scrollbar — it
never wraps and never widens the page. None of its buttons takes the focus on press, so the
canvas keeps the keyboard.

**At the rail's foot, the two controls about looking rather than drawing**: hide/show all
objects (`Eye` / `EyeOff`, pressed while everything is hidden), which writes the same hidden
set as the panel's per-row eyes — all hidden ↔ none hidden — and is disabled with its reason
on a frame with no objects; then help. It has no key.

**Undo and redo** are in the island, with the other moves made on every frame — see *The
layout*.

The geometries with no tool behind them, `aria-disabled` rather than `disabled`, and the
suggest tool's whole flow are in [`docs/content/ui.md`](../ui.md).

## The frame gallery

The island's frame button (`⊞ n / m`) opens the job's frames as a thumbnail overlay over the workspace — square
tiles with the photo-icon fallback, each carrying its frame number and its status dot, with
the **word** in the tile's accessible name and tooltip because a tile has no room for
prose. The current frame is marked and takes the focus on open, which is also what scrolls
it into view. Above the grid, a four-segment filter
(`All / Unannotated / In review / Done`), counted over *this job's* frames. **One press
opens a frame** — no select-then-open — through the same save-first path `‹` and Next use, so
a refused save keeps the work and the frame. Escape or the scrim returns to exactly the
frame, zoom, pan and armed class that were there. **No batch actions of any kind**: no
approve, no promote, no selection, no bulk bar. It is a switcher; the batch's panel on the
Overview is the home of batch operations.

## Zoom, pan, and the device model

**Zoom widget**: floating bottom-right of the stage, on the island's baseline — rising above
it where the picture is too narrow for both — with the stage's own chip chrome — `− / readout / + / fit / fullscreen`. Zoom changes how the work is looked at,
not the work, which is why it is not on the bar. Fullscreen is requested on the
**stage** element rather than the document, so the picture and the widget go with it,
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

The workspace opens as a **viewer** whenever the wire withholds `annotate` on the frame — an
`approved` batch nobody has started, a completed batch, a finished job, or a settled frame
inside an open one. Opening never starts the batch: while it declares `start`, the banner
carries `Start annotating`, and pressing it is what turns the page into the editor, in place. The mode is the
frame's own declaration (`allowed_actions`), never this page's arithmetic.

**It is also a transition, not only an entry state.** Pressing `Finish job` turns the
workspace into a viewer **in place** — same window, no navigation, no reload — across every
frame of the job: the mutation invalidates the frames' declarations and the page
re-derives. The press says so out loud with a toast, because everything else it does is a
subtraction, and a screen with less on it is not an explanation.

What a viewer is:

- **One explanation surface.** The banner over the stage says `Viewing only.` with the
  cause, and — when the wire declares `create_correction` — the route onward:
  `Correct this batch`. It renders on every frame of a closed batch or a finished job,
  including skipped ones, where the skipped notice would otherwise promise an Un-skip the
  wire withholds. Three causes, three sentences, ranked: a closed batch carries the
  correction route; a finished job names itself and offers nothing, because the job model
  has no way back and the batch is still open; a settled frame in an open batch points at
  the control on this very toolbar.
- **No classes region.** The panel is the objects region alone, at full height — the
  region, its filter, its quick-create and its hotkey badges are absent, not disabled, and
  `C` and the digits do nothing. *What may I draw* is not a question a viewer can ask.
- **Selection highlights; it does not advertise.** A selected shape renders the selected
  treatment — stroke 3, the label — with no grips and no vertex dots, and the cursor is the
  default arrow everywhere: no resize keywords, because no such gesture exists. A polyline
  is the exception for dots: its vertices carry recorded visibility, so a selected lane
  draws them, the hollow occluded marker included, as something to read rather than drag.
- **The rail renders, carrying navigation and nothing else.** The hand is not a
  drawing tool — it is what a person reaches for when the picture is in the wrong place —
  and navigating a batch nobody may edit is most of what a viewer does, so the rail keeps
  the hand, hide/show all objects and the shortcut sheet and loses every other button. The
  island withholds undo and redo on a settled frame and drops them once the job is closed.
- **Selection is one state, reflected everywhere.** A press on a shape selects it, and the
  objects panel's row highlights and scrolls into view. DOM focus stays with the canvas,
  which reads its chords off its own root.
- **Once the job is closed, the frame's own verbs go with it — and the job's does not.**
  `Skip` / `Un-skip` stop rendering on every frame of a completed batch or a finished job. **The gate is the job, never the frame**, and both
  halves are load-bearing: a merely *settled* frame inside a working job keeps them, greyed —
  `Un-skip` is the one way back out of a skipped frame — while a closed job withholds every
  move on every frame alike, so walking it changes nothing in the island. `Finish job` stays
  on the last frame: `complete` is the *job's* declaration, and a job whose last frame
  happens to be `accepted` would otherwise have no way to be finished. Once finished it
  reads `Finished`, the page's standing statement that the work is over.
- **Navigation stays whole.** `‹`, Next, the counter, the frame gallery and a track's steps all
  work, and no save-first guard engages — there is nothing to save, and nothing ever autosaves.
  The Tracks region stays, with every write withheld as `Viewing only`.
- **Reads stay live.** Zoom, pan, fullscreen, visibility toggles, the object filter, and
  copy — the road a box takes into a correction batch — all work; paste and every other
  write is refused at the engine (`readOnly` on the canvas, `READ_ONLY_KINDS` for the
  keyboard).

## Editing cuboids and polylines on a scan

A scan's cuboids and polylines are edited in an explicit **Edit** mode, switched on from the strip at the top
right of the scan view, below the status tag and object count, so orbiting never competes with drawing. In Edit a left drag edits, a
right drag orbits, and a middle drag - or shift + right drag, for a trackpad - pans; the wheel
still zooms. Outside Edit the view keeps its own mapping: a left drag orbits.

- **Draw.** With the cuboid tool and a class picked, drag one edge of the footprint on the
  ground (the scan's low robust height along the declared up): the drag is the box's length,
  and its direction is the box's heading, so a new box starts at the yaw of the drag, read in
  the declared frame's forward and left axes like every other yaw. A drag shorter than the
  smallest extent (5 cm) has no direction and draws nothing. Then move the pointer to either
  side of that edge to set the width, across the heading, and click or press Enter; then move
  the pointer to raise the height, and click or press Enter to finish. While the width or the
  height is being set the strip says so, and how to go on, on a line of its own, and when the
  footprint drag ends with focus outside both views, focus moves to the perspective view, so
  Enter goes on from the keyboard. The class pick lists only classes that declare `cuboid_3d`;
  with none, the tool is disabled with that reason.
- **Draw a polyline.** With the polyline tool and a class picked, click along the line; each
  click places a vertex under the pointer, and the last segment follows the pointer. A vertex
  takes the height of the scan point under the pointer: the point nearest the pointer on
  screen within 10 px, and among points about as near (within 3 px of the nearest), the one
  nearest the eye, so the vertex lands on the surface in view rather than one hidden behind
  it; in the top-down view that is the topmost point. Only the height is taken: the vertex
  stays exactly under the pointer and never jumps sideways to the point. Where no point is
  within 10 px, the vertex falls back to the ground plane, at the same height a cuboid's
  footprint uses. A cuboid's footprint never snaps. Enter or a double-click finishes the line, and Escape
  cancels it. A line needs at least two vertices that are not all in one place; finishing one
  that has fewer is refused and the drawing carries on. The class pick lists only classes that
  declare `polyline_3d`; with none, the tool is disabled with that reason. While the tool is
  active the strip says how to finish, on a line of its own.
- **Adjust.** With the select tool, a press on a box selects it and drags it along the ground;
  the selected box shows a handle on each face turned towards the camera, which pushes that
  face, and a dashed ring at its base, which turns its yaw about the declared up. A face on the
  far side of the box shows no handle and cannot be grabbed through the box; orbit round to
  reach it. The bottom face is turned towards the camera only from below the box. The
  test is the box's own faces against the eye: a handle in front of the box but behind other
  points or another box is still drawn and grabbed, as nothing tests depth against the cloud or
  other labels. Handles and ring are an overlay placed by the same projection the editor picks
  with, and the overlay and the hit test share one test for which faces are offered.
- **Adjust a polyline.** A click on a polyline's segment selects it, and the selected polyline
  shows a handle on each vertex. Dragging a handle moves that vertex under the pointer, at the
  height of the scan point there by the same rule as drawing, and at the vertex's own height
  where no point is near. A press on a segment of the selected polyline inserts a vertex there,
  at the scan's height under the pointer or else on the segment, and drags it, as one undo
  step. Alt-click on a vertex removes it, never below two vertices; alt-click
  anywhere else does nothing. A removal or drag that would leave every vertex in one place is
  refused. Delete removes the whole label. Per-vertex visibility is not editable on a scan: a
  new polyline leaves it out, so it stays unknown, and an imported polyline keeps its declared
  visibility, with an inserted vertex recorded as unlabeled (`0`).
- **Top-down.** In Edit a second view sits beside the perspective one - below it on a narrow
  stage - looking straight down the declared up axis, forward up the screen. It is
  orthographic, so a box's top lies over its footprint at any zoom, and it follows the
  perspective view's centre: a pan there moves it too. It never orbits; a right or middle drag
  pans it and the wheel zooms it about the pointer, keeping the ground under it in place.
  While it sits beside the perspective view, the object count and hint keep to the perspective
  one. It drives the same editor, store and selection, so a drag in
  either view moves the box in both while it is under way. Over the selected box it draws the
  footprint, a handle on each of the four side faces, and the yaw ring with a handle where the
  heading crosses it; the top and bottom faces sit on the box's centre there, so a press on the
  centre moves the box. A footprint can be drawn there too, but a height is never read from
  it: raise the height in the perspective view, or finish with a click or Enter and pull the top
  face up later.
- **Keys.** With the view focused: Delete removes the selection, Escape cancels a gesture or
  lets go of the selection, Enter finishes a height or a polyline, `mod+z` / `mod+shift+z` undo and redo,
  `mod+s` saves, and `?` opens or closes the scan's shortcut list. The keys are one table,
  `SCAN_KEY_BINDINGS`: the handler resolves a press against it and the list (Keyboard shortcuts in the
  `⋯` menu, or `?`) renders its rows, so the two cannot drift; the 2D sheet is never shown on a scan.
  Enter and `X` do not advance or skip on a scan: Enter is the editor's commit, and a key that
  moved to the next scan mid-edit would be a lost gesture, so Next and Skip are the island's alone.
  Undo and redo are the island's: one pair, which the keys send too.
  While a label is being drawn, undo steps the draft back — the last vertex of a polyline,
  a box's height back to its width, its width to nothing — and leaves the history alone, and
  redo does nothing; during a drag both drop the drag first and then undo or redo. A box's
  width and height are read from where the click that sets them lands, so a tap with no
  hover before it draws what it points at. As in the 2D editor, a click on the
  strip, the view's controls or a panel row leaves focus on the view: a row's press does not take
  focus, and if focus was not in the perspective view it goes there, so Delete acts on
  the row just selected.

The selected box and the box being drawn are drawn in the foreground token over the class
colours. Labels stay on while editing. The Annotations panel lists each cuboid and polyline; its row
selects the label and deletes it through the same history as the keyboard. The panel shows no
Classes region on a scan: its classes arm the 2D tools, and a scan label's class is picked in
the strip.

A scan's edits share the page's one save plan and dirty state with the image document: the
autosave, `Next`, `mod+s` and the unsaved-changes guard all cover them, a cuboid created on the
page and already stored is saved again under the server's id, and an edited import keeps
its provenance. On a scan the island's undo and redo walk the scan labels' history, by the
rule under *Keys*, and the tool rail, the tool's own bar, the 2D hint and the zoom widget are
absent: the strip and the view carry those. Every sentence on a scan's page names a scan — the
island, the job's progress, the review move, Skip and Un-skip, Finish job, the banners and the
skipped notice — and the only "frame" left is the coordinate frame. Edit is disabled, with the
reason on the control, while the scan's source is being read, when its source declares no
frame (the server refuses every 3D write there), when the request for the source fails, or
when the scan is open for viewing only. A failed source request is said as one: the stage
shows the refusal with a retry and the summary reads `frame unknown`, never that the source
declares none; a scan that turns read-only mid-edit leaves Edit on the same render.

## The stage

The area around the asset is the **`stage`** token, never `muted`, and **the stage follows
the page theme**: a light grey on the light page, a dark grey on the dark one. It never
switches on its own. It is a role of its own for two reasons: the surround shifts the
perceived contrast and colour of the photograph inside it, which is a real cost on a tool
whose whole job is looking closely at pixels, so it is a quiet neutral rather than any
surface that happens to be near — and a stage darker or lighter than the page around it
would make the one screen somebody sits in front of for an hour read as a different
application. A scan sits on the same stage, and its points and legend follow the same
theme (*The scan view* in [`DESIGN.md`](../../../DESIGN.md)).

It must stay distinguishable from the page background as well as from the image: an asset
with white borders has to show where it ends. The e2e suite asserts the contrast gap on the
light page rather than the hex; the dark page is held by the visual baselines. `stage` is a
VisionSet-specific semantic token and is recorded as such in [`DESIGN.md`](../../../DESIGN.md).

## The rotated box

A class declaring `obb` gets the **rotated box** tool (lucide `RotateCwSquare`), derived from the
class like every other tool. A drag draws an axis-aligned rectangle, stored at angle 0 in its
canonical spelling - a tall drag is stored as the wide box turned a quarter, `width >= height` at
`-pi/2` (see [annotations](../annotations.md#a-rotated-box-is-a-centre-a-size-and-an-angle)); a
click too short to be a drag draws nothing. Selected, it offers:

- **eight grips in its own turned frame**, the four corners and the four side midpoints. A grip
  holds the opposite corner or side still, flips the box when dragged past it, and never lets a
  side fall below the box tool's minimum; the resize cursors turn with the box;
- **a round rotation grip** on a stem 24 screen pixels beyond whichever side faces most upward on
  screen, so it stays above the box however it is spelled; it turns the box about its centre by
  the angle the pointer sweeps (`grab`, `grabbing` while turning);
- **its body**, which moves it; the centre is kept on the asset, so the box always meets it.

While a drag is under way the box keeps its raw values, so a grip never jumps sides mid-gesture;
the release commits the canonical spelling, Escape restores the box as it was, each gesture is one
undo step, and copy and paste carry it like a box. It renders as its four edges, a closed outline
in the class colour.

## Shape rendering

One class-colour rule shared by the canvas, the side panel swatches, and the class
badges elsewhere in the app: `classColor` in `frontend/annotator/src/adapters/react/paint.ts`. `ui-core`
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
at a glance. A detection candidate left out of the accept is drawn as excluded rather than
merely fainter: a dotted outline, a black-and-white hatch in place of its fill (so it reads
over a photograph whose colour matches the class, in either theme), vertices muted further,
and `left out` after its label.

**An occluded stretch of a polyline is dashed, with a pattern of its own.** A segment is
occluded when either of its vertices is recorded occluded, so the line reads hidden from the
hidden vertex onward; consecutive occluded segments draw as one run, and the solid and dashed
runs share their joining vertex. The dash is short and widely spaced — 2 on, 6 off, in screen
pixels — so it is told apart from the drawing preview's `6 4` and a suggestion's `10 6`. An
`unlabeled` vertex draws like a visible one. While the lane is selected an occluded vertex is
hollow, its outline dashed. A polyline with nothing occluded is one solid line, exactly as
before.

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
discarded — `confidence` and `model_ref` are stored unchanged — and its home is the review of model
labels, where a surface showing it must also name *what it measures*: a point-prompted
mask score and a detection's prompt affinity are different quantities on different scales
and cannot be pooled, thresholded or sorted together. **Where it is shown, it has one
spelling, and that is whole percent**: `confidencePercent` in
`frontend/annotator/src/adapters/react/paint.ts` — whoever shows the number imports it,
because two notations for one quantity is a number that disagrees with itself. A `null`
confidence reads as absent — never as `0`, never as a low score.
