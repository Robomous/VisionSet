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
 * The accumulated classes are held **here** and nowhere else, which is what makes
 * "cancel discards them" true by construction: there is no draft on the server to
 * clean up, and the only state that can be lost is state nothing else can see.
 * Cancelling with classes pending therefore *asks*, because that is the one press
 * in this dialog that destroys work somebody typed.
 */

import { Plus, X } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import { asApiError } from "../data/errors";
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
import { ClassFields } from "../patterns/ClassFields";
import type { LabelClassBody, SchemaVersion } from "../screens/queries";

/** A fresh class, in the shape the wire takes. */
function blank(): LabelClassBody {
  return { name: "", geometry: "bbox", color: null, attributes: [] };
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
  await steps.publish([...steps.activeClasses, ...steps.added], steps.note);
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
}: AddClassDialogProps): JSX.Element {
  const [declared, setDeclared] = useState<LabelClassBody>(blank);
  /** Written, not yet published. One press turns the whole list into one version. */
  const [session, setSession] = useState<readonly LabelClassBody[]>([]);
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  /** Cancel was pressed with classes pending, and is asking before it discards them. */
  const [discarding, setDiscarding] = useState(false);

  const name = declared.name.trim();
  const failure = error === null || error === undefined ? null : asApiError(error);
  // Case-insensitively, because `create_version` refuses a collision that way —
  // mirroring the API's rule rather than inventing a second one. The session is
  // checked alongside the active version, because two classes in one press go
  // into one contract and `create_version` judges that contract as a whole: a
  // collision inside the session is refused by exactly the same rule, and
  // discovering it from a 409 after the save would be the worst place to learn it.
  const collides = (candidate: string): boolean =>
    (active?.classes.some((entry) => entry.name.toLowerCase() === candidate.toLowerCase()) ??
      false) || session.some((entry) => entry.name.toLowerCase() === candidate.toLowerCase());
  const taken = name !== "" && collides(name);

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
  const publishing: readonly LabelClassBody[] = readyForm
    ? [...session, { ...declared, name }]
    : session;
  const description = touched ? note : defaultNote(publishing.map((entry) => entry.name));

  function reset(): void {
    setDeclared(blank());
    setSession([]);
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

  /** Bank the form and clear it, so the next class starts from nothing. */
  function addAnother(): void {
    if (!readyForm) return;
    setSession((banked) => [...banked, { ...declared, name }]);
    setDeclared(blank());
  }

  /**
   * Closing, and the one press in here that can destroy typing.
   *
   * Everything the session holds lives in this component — there is no draft on
   * the server — so cancelling loses exactly what somebody wrote and nothing
   * else. That is why it asks, and why nothing else in this dialog does.
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
                  className="flex items-center gap-1.5 rounded-full border border-border bg-muted py-0.5 pl-2 pr-1 text-meta"
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
                  <span className="text-muted-foreground">{entry.geometry}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${entry.name}`}
                    data-testid={`session-remove-${entry.name}`}
                    disabled={pending}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-card hover:text-foreground disabled:cursor-not-allowed"
                    onClick={() =>
                      setSession((banked) => banked.filter((held) => held.name !== entry.name))
                    }
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
                geometry: declared.geometry,
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

          {taken && (
            <Alert variant="destructive" title="That name is taken">
              {/* Which of the two rules refused it, because the remedies differ:
                  a collision with the published version is a class that already
                  exists to pick, and one inside the session is a name typed
                  twice. */}
              {session.some((entry) => entry.name.toLowerCase() === name.toLowerCase())
                ? `You have already added a class called “${name}” to this version.`
                : `Version ${active?.version} already declares a class called “${name}”.`}{" "}
              Class names are unique within a version, ignoring case.
            </Alert>
          )}

          {failure !== null && (
            <Alert variant="destructive" title={failure.code} data-testid="add-class-error">
              {failure.message}
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
              written and not published. Closing now loses {session.length === 1 ? "it" : "them"} — nothing
              has been sent yet.
            </Alert>
          )}
        </div>

        <DialogFooter>
          {discarding ? (
            <>
              <Button variant="secondary" data-testid="keep-editing" onClick={() => setDiscarding(false)}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                data-testid="discard-confirm"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Discard
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
                <kbd className="ml-1 rounded border border-border px-1 font-mono text-meta text-muted-foreground">
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
                  : canRepin
                    ? publishing.length > 1
                      ? `Add ${publishing.length} classes`
                      : "Add class"
                    : "Publish without re-pinning"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
