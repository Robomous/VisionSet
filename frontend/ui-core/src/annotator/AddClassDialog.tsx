/**
 * Adding a label class without leaving the job.
 *
 * ## The problem it removes
 *
 * Before #233, a user who needed a class that did not exist had this path: leave
 * the job, open the project's Schema tab, publish a version, make a **new batch**
 * — because the old one pins the old version — and re-partition. The class they
 * wanted was two minutes and a lost place in the queue away.
 *
 * ## Three calls, and the order is the whole design
 *
 * 1. **Save the pending annotations.** They are valid under the *old* schema and
 *    the change is additive, so this cannot be refused.
 * 2. **Publish the next version**, built on the project's **active** classes plus
 *    the new one — never on the batch's pin. Versions are linear: composing on a
 *    pin that is behind the active version would silently delete every class
 *    published since, which is a destructive change nobody asked for.
 * 3. **Re-pin the batch** (#229) onto that version, which is what makes the class
 *    usable *here* rather than in the next batch somebody makes.
 *
 * **Step 1 must come first, and a test asserts the order.** `Workspace` builds the
 * annotator store in a `useMemo` keyed on the schema, so the refetch that follows
 * step 3 *rebuilds the store* — discarding unsaved edits and the undo history. Do
 * step 2 before step 1 and the user's last few boxes are gone, with a success
 * toast on screen. Losing undo history at a save boundary is the page's existing,
 * documented behaviour ("saving is a diff, and then a reload"); losing *work* is
 * not, and the ordering is the only thing standing between them.
 *
 * Teaching the headless core to swap a schema into a live document was considered
 * and declined: it touches the document model for marginal gain over saving first.
 *
 * ## Nothing is half-applied, and where it can stop
 *
 * The three calls are not a transaction, and cannot be — they are three requests.
 * What each failure leaves behind is stated rather than hidden:
 *
 * | fails at | what exists afterwards |
 * | --- | --- |
 * | save | nothing published, nothing moved; the edits are still on screen |
 * | version | the edits are saved; no new version |
 * | re-pin | **the version exists and the pin has not moved** |
 *
 * The last row is the one worth naming to the user, because the remedy is not
 * "try again with a flag" — it is that somebody else narrowed the schema past this
 * batch's pin, and the Schema tab is where that gets looked at.
 */

import { useState, type JSX } from "react";

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
 * The auto-filled version description (#230).
 *
 * Pre-written rather than left empty because a version published from here is the
 * one somebody is *least* likely to describe — they are mid-annotation and think
 * of this as adding a label, not as publishing a contract. Editable, so it is a
 * default and not a decision made for them.
 */
export function defaultNote(name: string): string {
  return `Added class ${JSON.stringify(name)} from the annotation view`;
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
  /** Move this batch's pin onto it. */
  readonly repin: () => Promise<unknown>;
  /** The **active** version's classes. Never the batch's pin — versions are linear. */
  readonly activeClasses: readonly LabelClassBody[];
  readonly declared: LabelClassBody;
  readonly note: string;
}): Promise<void> {
  await steps.save();
  await steps.publish([...steps.activeClasses, steps.declared], steps.note);
  await steps.repin();
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
  /** The batch's pin. Shown when it is behind, since that is why a re-pin happens. */
  readonly pinnedVersion: number | null;
  readonly pending: boolean;
  /** The refusal to render, or `null`. Owned by the caller: it runs the chain. */
  readonly error: unknown;
  readonly onSubmit: (declared: LabelClassBody, note: string) => void;
}

export function AddClassDialog({
  open,
  onOpenChange,
  active,
  pinnedVersion,
  pending,
  error,
  onSubmit,
}: AddClassDialogProps): JSX.Element {
  const [declared, setDeclared] = useState<LabelClassBody>(blank);
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  const name = declared.name.trim();
  const failure = error === null || error === undefined ? null : asApiError(error);
  // Case-insensitively, because `create_version` refuses a collision that way —
  // mirroring the API's rule rather than inventing a second one.
  const taken =
    active?.classes.some((entry) => entry.name.toLowerCase() === name.toLowerCase()) ?? false;

  function reset(): void {
    setDeclared(blank());
    setNote("");
    setTouched(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="add-class-dialog">
        <DialogTitle>Add a label class</DialogTitle>
        <DialogDescription>
          This publishes the next schema version and moves this batch onto it, so the class
          is usable here straight away. Unsaved work is saved first.
        </DialogDescription>

        <div className="flex flex-col gap-4">
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
              value={touched ? note : defaultNote(name === "" ? "…" : name)}
              onChange={(event) => {
                setTouched(true);
                setNote(event.target.value);
              }}
            />
          </div>

          {taken && (
            <Alert variant="destructive" title="That name is taken">
              Version {active?.version} already declares a class called “{name}”. Class names
              are unique within a version, ignoring case.
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
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="add-class-submit"
            // Disabled only for states a label cannot explain: a nameless class, a
            // duplicate, a schema that has not loaded, and a request in flight.
            // `DESIGN.md`'s rule is that a button answers or explains — the first
            // two explain themselves beside the field they are about.
            disabled={pending || name === "" || taken || active === null}
            onClick={() =>
              onSubmit(
                { ...declared, name },
                touched ? note : defaultNote(name),
              )
            }
          >
            {pending ? "Publishing…" : "Add class"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
