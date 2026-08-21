/**
 * Adding a label class without leaving the job.
 *
 * ## The problem it removes
 *
 * Without it, a user who needs a class that does not exist has this path: leave
 * the job, open the project's Schema tab, publish a version, make a **new batch**
 * — because the old one pins the old version — and re-partition. The class they
 * wanted was two minutes and a lost place in the queue away.
 *
 * ## Two calls, and the order is the whole design
 *
 * 1. **Save the pending annotations.** They are valid under the *old* schema and
 *    the change is additive, so this cannot be refused.
 * 2. **Publish the next version**, built on the project's **active** classes plus
 *    the new one — never on the batch's pin. Versions are linear: composing on a
 *    pin that is behind the active version would silently delete every class
 *    published since, which is a destructive change nobody asked for.
 *
 * **There was a third call and it is gone** (#381). The chain used to re-pin the
 * batch afterwards, which is what made the new class usable *here* rather than in
 * the next batch somebody makes. The kernel does that now, inside the same
 * transaction as the publish: adding a class is additive, and an additive version
 * takes every open batch with it. So the step this dialog used to orchestrate is
 * no longer a step.
 *
 * **Step 1 must still come first, and a test asserts the order.** `Workspace`
 * builds the annotator store in a `useMemo` keyed on the schema, so the refetch
 * that follows the publish *rebuilds the store* — discarding unsaved edits and the
 * undo history. Publish before saving and the user's last few boxes are gone, with
 * a success toast on screen. Losing undo history at a save boundary is the page's
 * existing, documented behaviour ("saving is a diff, and then a reload"); losing
 * *work* is not, and the ordering is the only thing standing between them.
 *
 * Teaching the headless core to swap a schema into a live document was considered
 * and declined: it touches the document model for marginal gain over saving first.
 *
 * ## Nothing is half-applied, and where it can stop
 *
 * The two calls are not a transaction, and cannot be — they are two requests.
 * What each failure leaves behind is stated rather than hidden:
 *
 * | fails at | what exists afterwards |
 * | --- | --- |
 * | save | nothing published, nothing moved; the edits are still on screen |
 * | version | the edits are saved; no new version |
 *
 * **Finding F23's row is gone from that table**, and not because it is handled:
 * it was *the version exists and the pin has not moved*, which needed a
 * `canRepin` preflight to avoid. Publishing and moving the pin are now one
 * transaction, so that state is unrepresentable rather than guarded against.
 *
 * ## One dialog session is one published version
 *
 * `Create and add another` accumulates. Somebody who opens this because the road
 * survey needs `cone`, `barrier` and `crossing` writes three classes and presses
 * once, and the project's history gains **one** version rather than three — with
 * three publishes, three refetches, and three chances for the middle one to refuse.
 *
 * The alternative — publish each class as it is written — turns a ledger into a
 * transcript. Accumulating does not remove the need to group versions in the
 * history (two sessions in a morning are still two versions) but it stops one
 * sitting from being nine of them.
 *
 * The accumulated classes also live on the server now, in the project's
 * `annotation` draft — a row of its own, kept apart from the Schema tab's
 * `curated` draft so a half-finished editor composition can never leak into what
 * this dialog publishes. Every bank writes through, so a closed tab loses
 * nothing. A dialog opened onto a draft that already holds classes does not fold
 * them into a fresh sitting silently: the draft is shared and has no author, so
 * those classes may be somebody else's, and the dialog says so rather than
 * publishing them on this person's say-so. Cancelling with classes pending still
 * *asks*, because closing now discards the shared draft too — not only this
 * browser's memory of it.
 *
 * **Both discard buttons hold their local "it is gone" state until the
 * server agrees.** Clearing the session and closing the dialog *before* the
 * `DELETE` resolves would tell somebody the shared draft is gone when a
 * refusal can still be sitting in `onDiscardDraft`'s rejected promise — they
 * would meet the same classes again next time, having been told they were
 * discarded. So both buttons disable themselves and every bank
 * (`addAnother` checks `pending` directly, since ⌘Enter reaches it without
 * going through a disabled attribute) for the length of that one request, and
 * only act on success; a refusal is left on screen through `error`, exactly
 * where every other refusal here renders.
 */

import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";

import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { classColor } from "../palette";
import { Alert } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { Input, Label } from "../primitives/Input";
import { formatGeometries } from "../data/geometryCategory";
import { ClassFields } from "../patterns/ClassFields";
import type {
  DraftLabelClassBody,
  LabelClassBody,
  SchemaVersion,
  ServerSchemaDraft,
} from "../screens/queries";

/** A fresh class, in the shape the wire takes. */
function blank(): LabelClassBody {
  return { name: "", geometries: ["bbox"], color: null, attributes: [] };
}

/**
 * A server draft's classes, in the shape this dialog holds them.
 *
 * `DraftLabelClassBody` allows an attribute with no `kind` yet — an ordinary
 * moment mid-typing, since a draft is not a contract — but this dialog's own
 * fields never leave one unset. An absent `kind` means some other writer left
 * this attribute unfinished; defaulting it keeps a resumed session open rather
 * than refusing to render somebody else's work.
 */
function fromDraft(classes: readonly DraftLabelClassBody[]): LabelClassBody[] {
  return classes.map((declared) => ({
    ...declared,
    attributes: declared.attributes.map((attribute) => ({
      ...attribute,
      kind: attribute.kind ?? "string",
    })),
  }));
}

/**
 * The auto-filled version description.
 *
 * Pre-written rather than left empty because a version published from here is the
 * one somebody is *least* likely to describe — they are mid-annotation and think
 * of this as adding a label, not as publishing a contract. Editable, so it is a
 * default and not a decision made for them.
 *
 * It takes the whole session rather than one name, because a session publishes
 * one version and a version has one description: naming only the last class would
 * make the ledger's `Why` column a lie about the other two. Every name is listed
 * rather than counted — a history reader wants to know *which* classes arrived,
 * and a session is realistically two to five.
 *
 * `JSON.stringify` per name, so a class called `zebra "x"` — legal, since
 * `normalize_name` only refuses a blank — cannot produce a sentence that reads as
 * truncated.
 */
export function defaultNote(names: readonly string[]): string {
  const quoted = names.map((name) => JSON.stringify(name));
  // Singular for none as well as for one: the empty case is the placeholder the
  // note field shows before a name is typed, and "Added classes …" over an empty
  // form promises a session nobody has started.
  const noun = quoted.length > 1 ? "classes" : "class";
  // "a, b and c" — no serial comma, which is what `DESIGN.md`'s copy rules use
  // everywhere else. An empty session is the placeholder case: the dialog shows
  // this before a name has been typed.
  const listed =
    quoted.length === 0
      ? '"…"'
      : quoted.length === 1
        ? quoted[0]
        : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return `Added ${noun} ${listed} from the annotation view`;
}

/**
 * The same names, for a sentence a person reads rather than a stored description.
 *
 * Curly quotes and no escaping, because this one is prose: `defaultNote` is
 * written into the ledger and has to survive a name containing a quote, while
 * this is a clause inside a paragraph and `\"` in the middle of one would read as
 * a bug. Falls back to a noun phrase, since it is rendered before anything is
 * typed.
 */
function namesInProse(names: readonly string[]): string {
  if (names.length === 0) return "this class";
  const quoted = names.map((name) => `“${name}”`);
  if (quoted.length === 1) return quoted[0] ?? "this class";
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * The three calls, in the one order that does not lose work.
 *
 * A function rather than a body inside a `useCallback` because **the order is the
 * behaviour**, and behaviour that matters is worth being able to test without a
 * canvas. `AnnotationPage` supplies three thunks and this decides when each runs;
 * `addClass.test.ts` supplies three recorders and asserts what came first.
 *
 * Sequential `await` rather than `Promise.all` or chained `onSuccess`: each step
 * must *not* run if the one before it refused, and a rejection has to reach the
 * caller as one failure rather than three that could each be showing.
 */
export async function runAddClass(steps: {
  /** Save the pending annotations. First, always — see the module docstring. */
  readonly save: () => Promise<unknown>;
  /** Publish the next version. Given the whole class list, composed by the caller. */
  readonly publish: (classes: readonly LabelClassBody[], note: string) => Promise<unknown>;
  /** The **active** version's classes. Never the batch's pin — versions are linear. */
  readonly activeClasses: readonly LabelClassBody[];
  /**
   * The session's classes, in the order they were written — one press, one version.
   *
   * A list rather than a single class. The chain does not change shape
   * for it: `create_version` takes the whole contract either way, so publishing
   * three new classes is the same one request as publishing one, and the *saving*
   * is the two extra publishes and two refetches that do not happen.
   */
  readonly added: readonly LabelClassBody[];
  readonly note: string;
}): Promise<void> {
  await steps.save();
  await steps.publish(composeVersion(steps.activeClasses, steps.added), steps.note);
}

/** Case-insensitively, because that is how `create_version` compares class names. */
function sameName(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase();
}

/**
 * The whole contract the next version declares: the active classes, with this
 * sitting's written **into** them.
 *
 * A name already in the active version **replaces its entry in place** rather
 * than being appended, and both halves of that matter. Appending would publish
 * two classes with one name, which `create_version` refuses outright — so the
 * rescue flow (widening an existing class rather than making a second one)
 * would fail at the API with a 422 that named nothing the user did. And
 * replacing *in place* rather than at the end keeps the authored class order,
 * which is not cosmetic: the class list renders in it and the digit hotkeys are
 * positions in it, so appending would silently renumber somebody's keyboard.
 *
 * Exported for its own test: it is the one piece of this chain that composes
 * rather than sequences, and the order it preserves is invisible from outside.
 */
export function composeVersion(
  activeClasses: readonly LabelClassBody[],
  added: readonly LabelClassBody[],
): readonly LabelClassBody[] {
  const updated = activeClasses.map(
    (existing) => added.find((one) => sameName(one.name, existing.name)) ?? existing,
  );
  const fresh = added.filter(
    (one) => !activeClasses.some((existing) => sameName(existing.name, one.name)),
  );
  return [...updated, ...fresh];
}

export interface AddClassDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * The project's **active** version, which the new one is composed on.
   *
   * `null` while it has not loaded. Submitting is refused until it has, because
   * composing on nothing would publish a version holding one class and drop every
   * other — the exact destructive change this flow exists never to make.
   */
  readonly active: SchemaVersion | null;
  /** The batch's pin. Shown when it is behind, which is what the refusal below names. */
  readonly pinnedVersion: number | null;
  /**
   * Whether this batch will take the new version's pin, from `allowed_actions`.
   *
   * False is not an error and does not disable anything — it changes what the
   * dialog *promises*. See the explanation it renders, and `runAddClass`'s note
   * about the half-applied chain this replaces.
   */
  readonly canRepin: boolean;
  readonly pending: boolean;
  /** The refusal to render, or `null`. Owned by the caller: it runs the chain. */
  readonly error: unknown;
  /**
   * The name to open with, from the create row that opened this.
   *
   * The class field's no-match row hands over what was typed —
   * `Create class "crossing"` — and dropping it would mean typing a name, being
   * told it does not exist, and then typing it again: the smallest possible way to
   * make a shortcut feel like a detour.
   *
   * Read on open rather than held as a controlled value: it is a starting point,
   * not a binding, and a prop that kept overwriting the field would make the
   * name uneditable.
   */
  readonly initialName?: string;
  /** Every class of the session, and the one description they publish under. */
  readonly onSubmit: (added: readonly LabelClassBody[], note: string) => void;
  /**
   * The project's `annotation` schema draft, or `null`/absent for one with
   * nothing pending. Seeds the session once, the moment this dialog opens onto
   * it — see the module docstring for why that seeding is announced rather than
   * silent.
   */
  readonly serverDraft?: ServerSchemaDraft | null;
  /**
   * Whether that read is still in flight. The seeding effect waits for it
   * rather than seeding an empty session and then never looking again.
   */
  readonly draftPending?: boolean;
  /**
   * Write the banked session through to the shared draft. Fired after every
   * bank and every removal, so a closed tab loses nothing but the form still in
   * progress. Absent for a caller with nowhere to send it.
   */
  readonly onBank?: (classes: readonly LabelClassBody[]) => void;
  /**
   * Throw the stored draft away — the server half of Cancel's discard and of
   * the resumed-draft banner's own button.
   *
   * A promise, not a fire-and-forget call: both callers hold the local
   * "it is gone" state (clearing the session, closing the dialog) until this
   * settles, so a refused DELETE cannot make somebody believe a shared draft
   * is discarded when it is still sitting on the server for the next opening
   * to meet again.
   */
  readonly onDiscardDraft?: () => Promise<unknown>;
}

export function AddClassDialog({
  open,
  onOpenChange,
  active,
  pinnedVersion,
  canRepin,
  pending,
  error,
  initialName,
  onSubmit,
  serverDraft,
  draftPending,
  onBank,
  onDiscardDraft,
}: AddClassDialogProps): JSX.Element {
  const [declared, setDeclared] = useState<LabelClassBody>(blank);
  /** Written, not yet published. One press turns the whole list into one version. */
  const [session, setSession] = useState<readonly LabelClassBody[]>([]);
  /**
   * The names this session was seeded with, rather than typed here — what the
   * resumed-draft banner names. Set once, at the same moment `session` is, and
   * left alone after that: adding more classes this sitting must not make the
   * banner read as if the earlier ones had never existed.
   */
  const [resumedNames, setResumedNames] = useState<readonly string[]>([]);
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  /** Cancel was pressed with classes pending, and is asking before it discards them. */
  const [discarding, setDiscarding] = useState(false);

  const name = declared.name.trim();
  const failure = error === null || error === undefined ? null : asApiError(error);

  // Case-insensitively throughout, because `create_version` compares names that
  // way — mirroring the API's rule rather than inventing a second one. Checked
  // here rather than learned from the 422 afterwards, because the dialog needs
  // the answer *before* the press to know what the press will do.
  //
  // **The two collisions are different questions and only one of them is a
  // refusal.** A name already in the published version is a class that exists,
  // and wanting to draw it as another shape is a thing somebody legitimately
  // wants — so it becomes an offer to widen that class. A name typed twice in
  // this sitting is a mistake with nothing to offer: both entries are being
  // written now, and merging them would be guessing which of the two the user
  // meant.
  /** The published class this name lands on, if there is one. */
  const existing =
    name === "" ? undefined : active?.classes.find((entry) => sameName(entry.name, name));
  const inSession = name !== "" && session.some((entry) => sameName(entry.name, name));
  /** What this form would add to that class. Empty when it asks for nothing new. */
  const widening =
    existing === undefined
      ? []
      : declared.geometries.filter((geometry) => !existing.geometries.includes(geometry));
  const taken = inSession || (existing !== undefined && widening.length === 0);

  /**
   * What this form publishes: a new class, or the existing one widened.
   *
   * The widening carries the **existing** class's colour and attributes, not the
   * form's. This is an update to a class that already has both, and the form was
   * opened to make a *new* one — so publishing its blank colour and empty
   * attribute list would quietly wipe what the class already declared, which is
   * not what "add polygon to it" says. Only the geometries move.
   */
  const formEntry: LabelClassBody =
    existing === undefined
      ? { ...declared, name }
      : { ...existing, geometries: [...existing.geometries, ...widening] };

  /**
   * What pressing the primary publishes: the session, plus whatever is in the
   * form.
   *
   * The form counts without being added first, deliberately — somebody who wrote
   * one class and pressed the primary is done, and making them press
   * `Create and add another` first would be a ceremony that exists only because
   * the implementation has two places to look.
   */
  const readyForm = name !== "" && !taken;
  const publishing: readonly LabelClassBody[] = readyForm ? [...session, formEntry] : session;
  const description = touched ? note : defaultNote(publishing.map((entry) => entry.name));

  function reset(): void {
    setDeclared(blank());
    setSession([]);
    setResumedNames([]);
    setNote("");
    setTouched(false);
    setDiscarding(false);
  }

  /** Seed the name from the create row that opened this, once per opening. */
  useEffect(() => {
    if (!open) return;
    setDeclared({ ...blank(), name: initialName ?? "" });
    // `initialName` deliberately out of the deps: it is read *at* the opening, and
    // a caller whose value changes while the dialog is up must not overwrite what
    // somebody has since typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * Seed the session from a resumed draft — once per opening, and only once the
   * read has settled.
   *
   * A ref rather than a dependency on `serverDraft` itself: this must fire
   * exactly once per opening, and a bank write's own `setQueryData` gives that
   * value a fresh identity on every press. Depending on it directly would refire
   * this effect after every bank, overwriting whatever had since been typed —
   * the same trap a debounced write falls into when it addresses the render it
   * fires from rather than the opening it was scheduled for.
   */
  const seededRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      return;
    }
    if (seededRef.current || draftPending === true) return;
    seededRef.current = true;
    const banked = serverDraft == null ? [] : fromDraft(serverDraft.classes);
    setSession(banked);
    setResumedNames(banked.map((entry) => entry.name));
    // `serverDraft` deliberately out of the deps, for the reason above the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftPending]);

  /**
   * Bank the form and clear it, so the next class starts from nothing.
   *
   * `pending` is checked here, not only on the button's `disabled` — ⌘Enter
   * calls this directly and a keyboard shortcut walks straight past a
   * disabled attribute. Without it, a bank fired while the discard button's
   * DELETE is still in flight would race that unconditional delete: if the
   * server takes the bank's `PUT` first and the `DELETE` second, the class
   * this press just banked is gone, and nothing here would know to say so.
   */
  function addAnother(): void {
    if (!readyForm || pending) return;
    const banked = [...session, { ...declared, name }];
    setSession(banked);
    onBank?.(banked);
    setDeclared(blank());
  }

  /**
   * Closing, and the one press in here that can destroy typing.
   *
   * The session is now also the shared `annotation` draft on the server, so
   * cancelling with classes pending would delete something anyone else with a
   * credential to this project might be relying on — not only this browser's
   * memory of it. That is why it asks, and why nothing else in this dialog does.
   */
  function requestClose(): void {
    if (session.length > 0) {
      setDiscarding(true);
      return;
    }
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      // Escape and the overlay come through here too, which is the whole reason
      // the ask lives in `requestClose` rather than on the Cancel button: a
      // guard only the button honours is a guard Escape walks straight past.
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
          return;
        }
        requestClose();
      }}
    >
      <DialogContent
        data-testid="add-class-dialog"
        // **Wider than the default `max-w-lg`, and the reason is not taste.**
        // `ClassFields` splits Name | Geometry on `md:`, which is a *viewport*
        // breakpoint rather than a container one — so on any desktop the grid
        // splits however narrow the box is, and at 512px each column was ~224px
        // against a geometry row needing ~269px. The box has to be wide enough
        // for a split it cannot prevent. `2xl` is the smallest that clears it;
        // `3xl` is what DESIGN.md gives a whole forms *page*.
        //
        // The height pair is a second defect, fixed here because it is the same
        // string: this dialog had no `max-h` and no scroll, and `DialogContent`
        // is centred with `-translate-y-1/2`, so content taller than the viewport
        // overflowed off both edges and took the footer with it. A class with a
        // few attributes reaches that. Spelled as `ShortcutSheet` spells it.
        className="max-h-[85vh] sm:max-w-2xl overflow-y-auto"
        // ⌘Enter banks the class and clears the form — the chord for "and
        // another", so a session is typed without the hand leaving the keyboard.
        // On the content rather than on the name field, because the geometry
        // picker and the attribute rows are part of writing a class too.
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          addAnother();
        }}
      >
        <DialogTitle>{session.length === 0 ? "Add a label class" : "Add label classes"}</DialogTitle>
        <DialogDescription>
          {/* One version per press, said before the first `and another` rather
              than after it: the whole reason to accumulate is that a session is
              cheaper than a version each, and somebody who does not know that
              will publish three times out of caution. */}
          {/* Conditional, because the unconditional sentence was contradicted by
              the notice below it on a completed batch: this promised the batch
              would move while that one said it would stay. Adding a class is
              additive, so a batch that can take a pin always gets it — and the
              one that cannot is the one the notice is about. */}
          Everything you add here publishes as one schema version
          {canRepin ? " and moves this batch onto it, so the classes are usable here straight away" : ""}.
          Unsaved work is saved first.
        </DialogDescription>

        <div className="flex flex-col gap-4">
          {/*
            The one genuinely new state in this dialog: a draft this opening
            inherited rather than started. Named and offered a discard rather
            than folded silently into the session below — the draft has no
            author, so these classes may not be this person's, and confirming
            without seeing this would publish classes they never typed.
          */}
          {resumedNames.length > 0 && (
            <Alert title="Classes are already pending here" data-testid="resumed-draft">
              {namesInProse(resumedNames)} {resumedNames.length === 1 ? "was" : "were"} banked in an
              earlier sitting and never published — this draft is shared, so that may not have been
              you. Keep working to fold {resumedNames.length === 1 ? "it" : "them"} into this
              version, or clear the slate.
              <div className="mt-2">
                <Button
                  variant="secondary"
                  data-testid="discard-resumed"
                  disabled={pending}
                  onClick={() => {
                    // Held until the DELETE actually lands — clearing first and
                    // unconditionally is what let a refused discard tell somebody
                    // the shared draft was gone when it was not. `pending`
                    // already covers `onDiscardDraft`'s own mutation, so the
                    // button is disabled the moment this fires, and a second
                    // press (or a race with a bank, guarded in `addAnother`)
                    // cannot land while this one is still out.
                    const discarded = onDiscardDraft?.();
                    if (discarded === undefined) {
                      setSession([]);
                      setResumedNames([]);
                      return;
                    }
                    void discarded.then(
                      () => {
                        setSession([]);
                        setResumedNames([]);
                      },
                      () => {
                        // Left exactly as it was. The refusal reaches the
                        // screen through `error`, which the caller folds the
                        // discard mutation's own failure into.
                      },
                    );
                  }}
                >
                  {pending ? "Discarding…" : `Discard the pending ${resumedNames.length === 1 ? "class" : "classes"}`}
                </Button>
              </div>
            </Alert>
          )}

          {/*
            What is banked and not yet published. Absent until there is something
            to show, because a permanent empty list would be a promise of a
            feature on a dialog most people use once.
          */}
          {session.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" data-testid="session-classes" aria-label="Classes to publish">
              {session.map((entry) => (
                <li
                  key={entry.name}
                  data-testid={`session-class-${entry.name}`}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-muted py-0.5 pl-2 pr-1 text-xs"
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      background: classColor(
                        { ...entry, color: entry.color ?? null, attributes: [] },
                        entry.name,
                      ),
                    }}
                  />
                  {entry.name}
                  <span className="text-muted-foreground">
                    {formatGeometries(entry.geometries)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${entry.name}`}
                    data-testid={`session-remove-${entry.name}`}
                    disabled={pending}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-card hover:text-foreground disabled:cursor-not-allowed"
                    onClick={() => {
                      const banked = session.filter((held) => held.name !== entry.name);
                      setSession(banked);
                      onBank?.(banked);
                    }}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <ClassFields
            declared={declared}
            slot="new"
            // The one sanctioned spelling, so a class looks the same here, in the
            // palette and on the canvas: declared colour first, else the name hash.
            swatch={classColor(
              {
                name: declared.name,
                geometries: declared.geometries,
                color: declared.color ?? null,
                attributes: [],
              },
              // The seed a derived colour hashes. Constant while the name is empty,
              // so the dot does not flicker through a new hue on every keystroke
              // before there is a name to derive one from.
              declared.name || "new-class",
            )}
            // Unknown until it is published — the digit is palette order, and this
            // class has no place in the palette yet.
            hotkey={null}
            onChange={setDeclared}
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-class-note">Why this version</Label>
            <Input
              id="add-class-note"
              data-testid="add-class-note"
              value={description}
              onChange={(event) => {
                setTouched(true);
                setNote(event.target.value);
              }}
            />
          </div>

          {/*
            What pressing the button will and will not do, said before it is
            pressed (F23).

            Not a refusal and not a warning banner: publishing a version is a
            legitimate, useful act on its own — the project's schema moves on and
            the *next* batch is approved against it. The only thing that changes
            is what this batch is judged against, and the user is entitled to know
            that before they act rather than from an error afterwards.
          */}
          {!canRepin && (
            <Alert title="This batch will stay on its current version" data-testid="no-repin-notice">
              {/* The subject is the whole session, not the form field: by the time
                  somebody presses, the field is often empty and the classes are
                  banked — a notice saying “this class” would then name nothing at
                  all. The mechanism is unchanged; only what it points at is. */}
              A completed batch keeps the schema version it was approved against, so{" "}
              {namesInProse(publishing.map((entry) => entry.name))} will not be available to
              draw with here. The version is still published to the project, and a correction
              batch approved from now on will pin to it.
            </Alert>
          )}

          {/*
            A name already published is **not** a refusal, and this is where that
            shows. It used to be one — a red box saying the name was taken, which
            answered a question nobody asked: somebody typing a class that exists
            usually wants to draw it as a shape it does not have yet, and the
            product can simply do that. So the collision renders as an offer, and
            the primary below carries it. The only refusal left is a name typed
            twice in this one sitting, where there is nothing to offer.
          */}
          {existing !== undefined && widening.length > 0 && (
            <Alert title={`“${existing.name}” already exists`} data-testid="widen-offer">
              Version {active?.version} declares it as{" "}
              {formatGeometries(existing.geometries)}. Publishing adds{" "}
              {formatGeometries(widening)} to it, and leaves its colour and
              attributes alone.
            </Alert>
          )}

          {taken && (
            <Alert variant="destructive" title="That name is taken">
              {/* Which of the two rules refused it, because the remedies differ —
                  and each names what would clear it, which is what lets the
                  primary below stay disabled without being a bare grey box. */}
              {inSession
                ? `You have already added a class called “${name}” to this version. Rename one of them, or take the banked one back out.`
                : `Version ${active?.version} already declares “${name}” as ${formatGeometries(existing?.geometries ?? [])}, and this form adds nothing to it. Tick a shape it does not have, or choose another name.`}
            </Alert>
          )}

          {failure !== null && (
            <Alert variant="destructive" data-testid="add-class-error">
              {refusalProse(error)}
              {/* The one refusal whose remedy is somewhere else. `repin` has no
                  flag for it on purpose: the pin did not move because somebody
                  narrowed the schema past it, and that is a decision, not a retry. */}
              {failure.code === "DESTRUCTIVE_SCHEMA_CHANGE" && (
                <>
                  {" "}
                  The version was published, but this batch is still on v{pinnedVersion}.
                  Somebody narrowed the schema since this batch was approved — open the
                  project’s Schema tab to see what changed.
                </>
              )}
            </Alert>
          )}

          {/*
            The ask, inline rather than as a second Dialog over this one.
            A nested modal would take the focus off the classes it is asking
            about, and Radix's own guidance is that stacking dialogs is a last
            resort — the question is about *this* form, so it belongs in it.
          */}
          {discarding && (
            <Alert variant="destructive" title="Discard the classes you added?" data-testid="discard-session">
              {session.length} class{session.length === 1 ? "" : "es"} {session.length === 1 ? "is" : "are"}{" "}
              written and not published. Closing now discards {session.length === 1 ? "it" : "them"} from
              the shared draft — anyone else with this project open loses them too.
            </Alert>
          )}
        </div>

        <DialogFooter>
          {discarding ? (
            <>
              {/*
                Disabled while the discard is in flight along with its
                neighbour: "Keep editing" changing `discarding` back to false
                does not cancel the DELETE already sent, and a press through
                that window would abandon this screen while `onClick` below is
                still waiting on the promise that closes it.
              */}
              <Button
                variant="secondary"
                data-testid="keep-editing"
                disabled={pending}
                onClick={() => setDiscarding(false)}
              >
                Keep editing
              </Button>
              <Button
                variant="destructive"
                data-testid="discard-confirm"
                disabled={pending}
                onClick={() => {
                  // The close is held until the DELETE resolves — see the
                  // module docstring. Closing first, as this used to, told
                  // whoever pressed it that the shared draft was gone the
                  // instant they saw the dialog close, which was true only
                  // when the request happened to succeed.
                  const discarded = onDiscardDraft?.();
                  if (discarded === undefined) {
                    reset();
                    onOpenChange(false);
                    return;
                  }
                  void discarded.then(
                    () => {
                      reset();
                      onOpenChange(false);
                    },
                    () => {
                      // Stays open, still on the ask — `failure` renders below
                      // it from the same `error` prop the rest of the dialog
                      // reads, and the session is untouched because nothing
                      // was actually thrown away.
                    },
                  );
                }}
              >
                {pending ? "Discarding…" : "Discard"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" data-testid="add-class-cancel" onClick={requestClose} disabled={pending}>
                Cancel
              </Button>
              {/*
                The session's own button, and the reason it is not the primary:
                it does not publish anything. Same disabled rule as the primary's
                first two clauses, because a nameless or colliding class cannot be
                banked either — but *not* gated on `active`, which only matters at
                publish time.
              */}
              <Button
                variant="secondary"
                data-testid="add-another"
                disabled={pending || !readyForm}
                onClick={addAnother}
              >
                <Plus className="size-4" aria-hidden="true" />
                Create and add another
                <kbd className="ml-1 rounded border border-border px-1 font-mono text-xs text-muted-foreground">
                  ⌘↵
                </kbd>
              </Button>
              <Button
                variant="primary"
                data-testid="add-class-submit"
                // Disabled only for states a label cannot explain: nothing to
                // publish, a duplicate in the form, a schema that has not loaded,
                // and a request in flight. `DESIGN.md`'s rule is that a button
                // answers or explains — the first two explain themselves beside
                // the field they are about.
                //
                // `publishing.length === 0` rather than `name === ""`: with
                // classes banked the form is *meant* to be empty, and gating on
                // it would make a session unpublishable at exactly the moment it
                // is ready.
                disabled={pending || publishing.length === 0 || taken || active === null}
                onClick={() => onSubmit(publishing, description)}
              >
                {/*
                  The label is the explicit choice. Two different acts deserve two
                  different words, and the second one is the whole of F23's remedy:
                  the user reads what will happen on the button they are about to
                  press, instead of learning it from a refusal on a step they did not
                  ask for. The count is there because one press now covers several
                  classes and a bare "Add class" would under-report what it does.
                */}
                {pending
                  ? "Publishing…"
                  : !canRepin
                    ? "Publish without re-pinning"
                    : publishing.length > 1
                      ? `Add ${publishing.length} classes`
                      : // The one action the offer above promises, spelled as
                        // what it does. A press labelled "Add class" that in fact
                        // widened an existing one would be the interface doing
                        // something other than what it said.
                        existing !== undefined && widening.length > 0
                        ? `Add ${formatGeometries(widening)} to “${existing.name}”`
                        : "Add class"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
