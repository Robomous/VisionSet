/**
 * The *New model* and *Edit <name>* dialog: one form for both kinds of
 * connection, opened on the catalog.
 *
 * ## The model is the decision, so the dialog opens on the list
 *
 * Where it runs is a segmented control in the dialog's header — *Local* or
 * *Remote* (an `http` connection) — and creating opens on the first, so the person
 * meets the models this installation can run before anything else. The kind is
 * a switch rather than a first step because the two forms share their name and
 * their footer, and a step that asks one question and then disappears is a
 * screen nobody needed. Editing does not render the switch at all: the kind is
 * not editable, and offering it would be offering something the server refuses.
 *
 * The local form is the catalog as a list of radios, under the headings of the
 * abilities it serves, then **Custom model…**, which reveals the free model id
 * and revision. Under it, the name — which follows the chosen model until
 * somebody types one of their own — beside the device and the precision. One
 * line above the footer says what creating it commits to, and nothing else on
 * the form repeats it. What a field means beyond its label is an info card
 * beside the label (`InfoTip`), never a line under the field, and where the
 * meaning depends on the value — the model, the device, the precision — the
 * card says the current one.
 *
 * ## What the form offers, and what it refuses to compute
 *
 * The model list is the *installation's*: the server names every model an
 * installed driver offers, and the form renders what was served — so a driver
 * this repository never saw reaches the list by being installed. What a form
 * makes of that list, and the two vocabularies, live in `inferenceCatalog.ts`.
 *
 * A served list is a query, so the field has three states before it has a list:
 * it says it is reading, it renders a refusal as prose, or it says the
 * installation offers nothing by name. Curation guides without restricting:
 * **Custom model…** reveals the same free model id and revision fields the form
 * had before, and those fields are also what the last two states leave in place
 * — a model id typed by hand needs no catalog at all.
 *
 * The device and precision selects are the kernel's vocabularies,
 * offering-side. The kernel is what refuses a pair outside them — including
 * `cpu` with `fp16`, which both local adapters silently drop — and its refusal
 * renders here as prose like any other. This is not the hand-mirror
 * `ui-capabilities` bans: that rule is about `allowed_actions`, and no
 * field-level shape can carry which precision a device honours. A name another
 * connection already has is said under the field before Create, and the
 * server's refusal of a clash it alone can see still renders as today.
 *
 * ## The size is asked for before the connection exists
 *
 * The local form shows what a download would cost *before* somebody confirms,
 * for the selected model only — the catalog carries no size, and asking the hub
 * for every row would be one request per offer per opening. That is a query the
 * form makes about a published revision, not something the create response
 * could carry. The same query is what surfaces a missing local runtime, which is
 * why the form stays usable and shows the install command instead of disabling
 * itself.
 */

import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowUpRight, Check, Cpu, Globe, PencilLine } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import { asApiError } from "../data/errors";
import {
  useConnections,
  useCreateConnection,
  useDownloadSize,
  useProviders,
  useUpdateConnection,
  type Connection,
  type ConnectionType,
  type ConnectionInput,
  type ConnectionPage,
  type CuratedEntry,
  type ProviderPage,
} from "../data/inferenceQueries";
import { refusalProse } from "../data/refusals";
import {
  cn,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FieldDescription,
  FieldError,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@robomous/ui-core";
import { morphHeight, type Flight } from "../lib/motion";
import { ErrorState, LoadingState } from "../patterns/AsyncStates";
import { focusQuietly } from "../patterns/iconFocus";
import { InfoTip } from "../patterns/InfoTip";
import { Segmented, type SegmentOption } from "../patterns/Segmented";
import {
  CUSTOM_MODEL,
  DEVICES,
  DEVICE_LABEL,
  accessFor,
  defaultEntry,
  entriesOf,
  entryFor,
  groupsOf,
  precisionOn,
  precisionsFor,
  suggestedName,
  type CatalogGroup,
  type Precision,
} from "./inferenceCatalog";
import { bytes } from "./modelCopy";
import { OriginLogo } from "./OriginLogo";

const KIND_OPTIONS: readonly SegmentOption<ConnectionType>[] = [
  { value: "local", label: "Local", icon: Cpu, testId: "kind-local" },
  { value: "http", label: "Remote", icon: Globe, testId: "kind-http" },
];

/**
 * What each offered device is, for its info card. Keyed by the vocabulary, so a
 * device added there fails this build until it has a line here.
 */
const DEVICE_MEANS: Record<(typeof DEVICES)[number], string> = {
  cpu: "Runs anywhere, slowest",
  cuda: "An NVIDIA GPU",
  mps: "Apple Silicon’s GPU",
};

const PRECISION_MEANS: Record<Precision, string> = {
  fp32: "Full precision",
  fp16: "Half the memory, faster",
};

/** A field a person sets, in document order — never a field's info button. */
const FIRST_CONTROL = '[role=radio][tabindex="0"], input:not([type=hidden]), button[role=combobox], textarea';

/**
 * The dialog itself, which owns no form state at all.
 *
 * **The form is a child, so Radix mounts it per opening.** `DialogContent`
 * portals its subtree only while the dialog is open and unmounts it on close, so
 * every opening gets a fresh {@link ConnectionForm} and there is nothing to
 * reset.
 *
 * One long-lived component reset by an effect cannot hold that: the reset and
 * the effect that seeds the model run in the same commit over the same render's
 * state, so the second reads the *previous* session's kind and seeds a model
 * into a form that was told to forget one — which is how a local session
 * abandoned mid-load hands its model id to the next connection, an HTTP one
 * included. No guard fixes that, because a guard reads the same stale state.
 */
export function ConnectionDialog({
  open,
  onClose,
  editing,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly editing?: Connection;
}): JSX.Element {
  // What had the focus when it opened — New in the toolbar, or Edit in the
  // model's sheet. The dialog is opened by state, with no Radix trigger to
  // return to, so without this the focus would fall to the page on closing.
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {/* Wider than the dialog's default: a catalog row carries an id, a hint
          and a badge, and the name sits beside the hardware under it. Never
          taller than the window: on a short one the dialog scrolls rather than
          running its footer off the bottom edge. */}
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
        data-testid="connection-dialog"
        // Radix lands on the first tabbable, which on an edit is a field's info
        // button: its card would open unasked, and the first Escape would close
        // the card instead of the dialog. Land on the first control instead —
        // the kind, the model, or the name — quietly.
        onOpenAutoFocus={(event) => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const root = document.querySelector('[data-testid="connection-dialog"]');
          const first = root?.querySelector<HTMLElement>(FIRST_CONTROL) ?? null;
          if (first === null) return;
          event.preventDefault();
          focusQuietly(first);
        }}
        // Back where it was opened from, without opening that button's tooltip.
        onCloseAutoFocus={(event) => {
          const back = opener.current;
          opener.current = null;
          if (back === null || !back.isConnected) return;
          event.preventDefault();
          focusQuietly(back);
        }}
      >
        <ConnectionForm onClose={onClose} {...(editing === undefined ? {} : { editing })} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The whole form, header included — the header holds the kind, which is form
 * state.
 *
 * Every field starts where the opening puts it, in a `useState` initialiser
 * rather than in an effect — this component exists only while the dialog is
 * open, so there is one opening to initialise for and nothing to reset.
 */
function ConnectionForm({
  onClose,
  editing,
}: {
  readonly onClose: () => void;
  readonly editing?: Connection;
}): JSX.Element {
  // Asked for by the form and not by the screen: the catalog is this form's read,
  // and a screen that merely lists connections has no use for it. Nothing has to
  // say so — this component only exists while the dialog is open.
  const catalog = useProviders();
  // The same query the screen already holds, so this reads the cache rather than
  // asking again: the names a new one must not repeat.
  const connections = useConnections();
  const save = useSaveConnection(editing, onClose);
  const [start] = useState(() => startFrom(editing));
  const [kind, setKind] = useState<ConnectionType>(start.kind);
  // The name somebody typed, or `null` while the form is still suggesting one
  // from the model. An edit starts on the stored name, which is a decision.
  const [ownName, setOwnName] = useState<string | null>(start.name);
  // The free model id and revision — what **Custom model…** reveals and what an
  // endpoint names. Kept apart from the list's choice rather than written over
  // by it, so an offer chosen on this machine is never carried into the
  // endpoint's fields by flipping the kind: an HTTP connection names whatever
  // somebody else's server runs, and an id nobody typed there is one nothing on
  // screen explains.
  const [typedId, setTypedId] = useState(start.modelId);
  const [typedRevision, setTypedRevision] = useState(start.revision);
  // A device outside what a form offers — `cuda:1`, or a row from a build before
  // the vocabulary closed — is shown as it is rather than rewritten to the
  // nearest offered member behind somebody's back.
  const [device, setDevice] = useState<string>(start.device);
  const [precision, setPrecision] = useState<Precision>(start.precision);
  const [endpoint, setEndpoint] = useState(start.endpoint);
  const [credentialEnv, setCredentialEnv] = useState(start.credentialEnv);
  const local = kind === "local";
  const model = useModelChoice({ editing, local, catalog, typedId });
  const body = useKindMorph(kind);

  /**
   * Moving the device can strand the precision, so the precision moves with it.
   *
   * The kernel refuses `cpu` + `fp16`, so a form that left `fp16` selected while
   * the device went to `cpu` would be offering a pair it knows will be refused —
   * which is worse than either offering it and rendering the refusal or not
   * offering it at all.
   */
  function pickDevice(next: string): void {
    setDevice(next);
    setPrecision(precisionOn(next, precision));
  }

  const pair = pairOf(local, model.chosen, typedId, typedRevision);
  // Follows the model until somebody types a name of their own.
  const name = ownName ?? suggestedName(pair.modelId);
  const fixed = fixedModelOf(editing);
  const clashing = clashWith(connections.data, name, editing);
  const draft: Draft = { kind, name, ...pair, device, precision, endpoint, credentialEnv };
  const complete = clashing === null && isComplete(draft);

  function submit(event: FormEvent): void {
    event.preventDefault();
    // An endpoint's driver is never one this form picked: the stored one on an
    // edit, none on a create — even if the list seeded one before the kind was
    // flipped.
    if (complete) save.run(inputOf(draft, local ? model.providerId.current : storedProvider(editing)));
  }

  const nameField = <NameField value={name} onChange={setOwnName} clash={clashing} />;
  const typed = { id: typedId, onId: setTypedId, revision: typedRevision, onRevision: setTypedRevision };

  return (
    <>
      <FormHeader
        editing={editing}
        kind={kind}
        onKind={(next) => {
          body.measure();
          setKind(next);
        }}
        fixed={fixed !== undefined}
      />
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {/* What the kind swaps, as one box: it morphs from the height it had to
            the one it has, so the dialog's frame grows or shrinks about its
            centre instead of jumping. */}
        <div ref={body.ref} className="flex flex-col gap-4" data-testid="connection-body">
        {local ? (
          <LocalFields
            fixed={fixed}
            catalog={catalog}
            entries={model.entries}
            choice={model.choice}
            onChoose={model.pick}
            typed={typed}
            nameField={nameField}
            hardware={<HardwareFields device={device} precision={precision} onDevice={pickDevice} onPrecision={setPrecision} />}
          />
        ) : (
          <RemoteFields
            fixed={fixed}
            typed={typed}
            endpoint={endpoint}
            onEndpoint={setEndpoint}
            credentialEnv={credentialEnv}
            onCredentialEnv={setCredentialEnv}
            nameField={nameField}
          />
        )}
        {/* Nothing to commit to on a model that is already set up. */}
        {fixed === undefined && <CommitLine local={local} editing={editing !== undefined} entries={model.entries} modelId={pair.modelId} revision={pair.revision} />}
        </div>
        {save.failure !== null && <FieldError data-testid="connection-error">{refusalProse(save.failure)}</FieldError>}
        <FormFooter creating={editing === undefined} pending={save.pending} complete={complete} onCancel={onClose} />
      </form>
    </>
  );
}

/** Where every field starts, for one opening: the stored row's values, or a new local connection's. */
function startFrom(editing: Connection | undefined): {
  readonly kind: ConnectionType;
  readonly name: string | null;
  readonly modelId: string;
  readonly revision: string;
  readonly device: string;
  readonly precision: Precision;
  readonly endpoint: string;
  readonly credentialEnv: string;
} {
  return {
    // Creating opens on this machine; editing keeps the stored kind, which is
    // not editable.
    kind: editing?.connection_type ?? "local",
    name: editing?.name ?? null,
    modelId: editing?.model_id ?? "",
    revision: editing?.model_revision ?? "",
    device: editing?.device ?? "cpu",
    precision: editing?.precision ?? "fp32",
    endpoint: editing?.endpoint_url ?? "",
    credentialEnv: editing?.credential_env ?? "",
  };
}

/** What the form would send, before it becomes a request. */
interface Draft {
  readonly kind: ConnectionType;
  readonly name: string;
  readonly modelId: string;
  readonly revision: string;
  readonly device: string;
  readonly precision: Precision;
  readonly endpoint: string;
  readonly credentialEnv: string;
}

/**
 * The pair the connection names: the offer the list has selected, or whatever
 * was typed — on Custom, on an endpoint, or before the list decides.
 */
function pairOf(
  local: boolean,
  chosen: CuratedEntry | undefined,
  typedId: string,
  typedRevision: string,
): { readonly modelId: string; readonly revision: string } {
  const offer = local ? chosen : undefined;
  return {
    modelId: (offer?.model_id ?? typedId).trim(),
    revision: (offer?.model_revision ?? typedRevision).trim(),
  };
}

/**
 * The connection whose model is a fact rather than a field, if this is one.
 *
 * Read off the declaration, never off the state: a set-up connection does not
 * declare `update_model`, so its model is shown as a fact and the fields that
 * would move it are not offered. The reference still travels with the edit,
 * unchanged, because a mention is not a move.
 */
function fixedModelOf(editing: Connection | undefined): Connection | undefined {
  return editing !== undefined && !editing.allowed_actions.includes("update_model") ? editing : undefined;
}

function storedProvider(editing: Connection | undefined): string | null {
  return editing?.provider_id ?? null;
}

function isComplete(draft: Draft): boolean {
  return (
    draft.name.trim() !== "" &&
    draft.modelId !== "" &&
    draft.revision !== "" &&
    (draft.kind === "local" ? draft.device.trim() !== "" : draft.endpoint.trim() !== "")
  );
}

function inputOf(draft: Draft, providerId: string | null): ConnectionInput {
  return {
    name: draft.name.trim(),
    connectionType: draft.kind,
    modelId: draft.modelId,
    modelRevision: draft.revision,
    device: draft.device.trim(),
    precision: draft.precision,
    endpointUrl: draft.endpoint.trim(),
    credentialEnv: draft.credentialEnv.trim(),
    providerId,
  };
}

/**
 * Create or update, whichever this opening is, and the one refusal to render.
 *
 * The dialog closes only on success: a refusal leaves it open with what was
 * typed still in it, and the refusal under the fields.
 */
function useSaveConnection(
  editing: Connection | undefined,
  onClose: () => void,
): { readonly run: (input: ConnectionInput) => void; readonly pending: boolean; readonly failure: Error | null } {
  const create = useCreateConnection();
  const update = useUpdateConnection();
  function run(input: ConnectionInput): void {
    if (editing === undefined) create.mutate(input, { onSuccess: onClose });
    else update.mutate({ ...input, id: editing.id }, { onSuccess: onClose });
  }
  return {
    run,
    pending: create.isPending || update.isPending,
    failure: create.error ?? update.error,
  };
}

/** Cancel, and Create — or Save on an edit — held until the form is complete. */
function FormFooter({
  creating,
  pending,
  complete,
  onCancel,
}: {
  readonly creating: boolean;
  readonly pending: boolean;
  readonly complete: boolean;
  readonly onCancel: () => void;
}): JSX.Element {
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" variant="default" data-testid="connection-submit" disabled={!complete || pending}>
        {pending ? "Saving…" : creating ? "Create" : "Save"}
      </Button>
    </DialogFooter>
  );
}

/**
 * Another connection already called this, ignoring case — the rule the server
 * holds, said before Create rather than after it. The connection being edited
 * is not another one.
 */
function clashWith(listing: ConnectionPage | undefined, name: string, editing: Connection | undefined): string | null {
  const wanted = name.trim().toLowerCase();
  if (wanted === "" || listing === undefined) return null;
  const other = listing.items.find((one) => one.id !== editing?.id && one.name.toLowerCase() === wanted);
  // In the stored casing, which is the one the list shows.
  return other === undefined ? null : `“${other.name}” is taken in this workspace.`;
}

/**
 * Which row the model list shows, and the driver that offers it.
 *
 * The choice is an offered model id, the sentinel that reveals the free fields,
 * or `""` for undecided — the catalog is a query, so there is a real moment
 * before the form knows what it may offer, and an edit cannot resolve its stored
 * pair until the list arrives. Kept beside the model id rather than derived from
 * it, because a custom connection may name an offered model at another revision
 * and the list must go on showing "Custom" while it does.
 *
 * The driver is carried from the catalog entry rather than derived: a form
 * cannot know which installed driver offers a checkpoint, and the entry it just
 * read says so. A ref, because only the submit reads it.
 */
function useModelChoice({
  editing,
  local,
  catalog,
  typedId,
}: {
  readonly editing: Connection | undefined;
  readonly local: boolean;
  readonly catalog: UseQueryResult<ProviderPage, Error>;
  readonly typedId: string;
}): {
  readonly entries: readonly CuratedEntry[];
  readonly choice: string;
  readonly chosen: CuratedEntry | undefined;
  readonly pick: (next: string) => void;
  readonly providerId: { readonly current: string | null };
} {
  const entries = entriesOf(catalog.data?.items ?? []);
  const pending = catalog.isPending;
  const [choice, setChoice] = useState<string>("");
  const providerId = useRef<string | null>(editing?.provider_id ?? null);
  /**
   * Whether the sentinel on screen was seeded here rather than chosen.
   *
   * The list cannot tell the two apart by value, and they mean opposite
   * things: a sentinel this effect fell back to is a placeholder for a catalog
   * that had nothing to offer, and one somebody picked is a decision. A ref
   * rather than state because nothing renders differently for it.
   */
  const seededSentinel = useRef(false);

  /**
   * Decide what the list shows, once the catalog can answer.
   *
   * Two things used to happen synchronously and cannot: a new local connection
   * opened on a default read from a constant, and an edit resolved its stored
   * pair against one. Both now wait for a served list.
   *
   * **It seeds only where nobody has decided anything.** That is `choice === ""`,
   * and one more case: the sentinel this effect itself fell back to with no model
   * id typed under it. Without that second case a successful *Try again* left the
   * form on Custom with two empty fields while the list behind it filled up —
   * and with it *unrestricted*, a catalog arriving after somebody typed a model
   * id by hand would throw the id away.
   *
   * **Every dependency is a primitive but one.** A query hands back a fresh array
   * on every rebuild, and an effect depending on that array re-runs on every
   * render — which is how view state dies with nothing unmounting and no error to
   * show for it. `editing` is the exception, and a deliberate one: it is the
   * screen's `useState<Connection | null>`, captured when a row's Edit was
   * pressed, so it changes only when the dialog is opened for a different row and
   * the connection poll cannot churn its identity.
   */
  const fallback = defaultEntry(entries);
  const fallbackId = fallback?.model_id;
  const fallbackProvider = fallback?.provider_id;
  const storedChoice =
    editing === undefined
      ? undefined
      : entryFor(entries, editing.model_id, editing.model_revision)?.model_id;

  useEffect(() => {
    if (pending) return;
    const undecided =
      choice === "" || (choice === CUSTOM_MODEL && seededSentinel.current && typedId.trim() === "");
    if (!undecided) return;
    if (editing !== undefined) {
      seededSentinel.current = storedChoice === undefined;
      setChoice(storedChoice ?? CUSTOM_MODEL);
      return;
    }
    // An endpoint is offered no list, so nothing is seeded for one; flipping
    // back to this machine seeds then.
    if (!local) return;
    // Nothing is offered, or nothing offered answers a point prompt: the form
    // opens on its free fields rather than on a model nothing here can be asked.
    if (fallbackId === undefined) {
      seededSentinel.current = true;
      setChoice(CUSTOM_MODEL);
      return;
    }
    seededSentinel.current = false;
    setChoice(fallbackId);
    // The default is seeded here rather than through `pick`, so the driver has
    // to be recorded here too — a form that set it only in the handler would
    // send none for the model it opened on, which is the commonest create there
    // is.
    providerId.current = fallbackProvider ?? null;
  }, [choice, typedId, local, editing, pending, storedChoice, fallbackId, fallbackProvider]);

  /** Pick an offered entry — which names both halves of the pair — or reveal the fields. */
  function pick(next: string): void {
    // A decision, so the effect above leaves it alone from here on.
    seededSentinel.current = false;
    setChoice(next);
    const entry = entries.find((one) => one.model_id === next);
    // The sentinel clears the driver: it named whoever offered the entry being
    // left behind, and nothing offers what is about to be typed. The typed pair
    // is left as it is, so an id typed earlier survives a look at the list.
    providerId.current = entry === undefined ? null : entry.provider_id;
  }

  const chosen = choice === CUSTOM_MODEL ? undefined : entries.find((one) => one.model_id === choice);
  return { entries, choice, chosen, pick, providerId };
}

/** The title, the switch for where it runs (creating only), and one line on what this form is for. */
function FormHeader({
  editing,
  kind,
  onKind,
  fixed,
}: {
  readonly editing: Connection | undefined;
  readonly kind: ConnectionType;
  readonly onKind: (next: ConnectionType) => void;
  /** Whether the model is a fact rather than a field. */
  readonly fixed: boolean;
}): JSX.Element {
  return (
    <DialogHeader>
      <div className="flex flex-wrap items-center justify-between gap-3 pr-2">
        <DialogTitle>{editing === undefined ? "New model" : `Edit ${editing.name}`}</DialogTitle>
        {/* The kind is not editable, so an edit is offered no switch at all. */}
        {editing === undefined && (
          <Segmented label="Where it runs" testId="connection-kind" value={kind} onChange={onKind} options={KIND_OPTIONS} />
        )}
      </div>
      <DialogDescription>
        {kind === "http"
          ? "Point at a server that answers VisionSet’s inference contract."
          : fixed
            ? "Runs on this machine, with the weights it was set up with."
            : "Pick the weights to run on this machine."}
      </DialogDescription>
    </DialogHeader>
  );
}

/** The free model id and revision, and what changes them. */
interface Typed {
  readonly id: string;
  readonly onId: (next: string) => void;
  readonly revision: string;
  readonly onRevision: (next: string) => void;
}

/**
 * A connection on this machine: the model — the catalog, or the fact a set-up
 * connection's model now is — then the free fields **Custom model…** reveals,
 * then the name beside the hardware.
 */
function LocalFields({
  fixed,
  catalog,
  entries,
  choice,
  onChoose,
  typed,
  nameField,
  hardware,
}: {
  readonly fixed: Connection | undefined;
  readonly catalog: UseQueryResult<ProviderPage, Error>;
  readonly entries: readonly CuratedEntry[];
  readonly choice: string;
  readonly onChoose: (next: string) => void;
  readonly typed: Typed;
  readonly nameField: ReactNode;
  readonly hardware: ReactNode;
}): JSX.Element {
  return (
    <>
      {fixed !== undefined ? (
        <FixedModel connection={fixed} />
      ) : (
        <ModelField catalog={catalog} entries={entries} choice={choice} onChoose={onChoose} />
      )}
      {/* Whenever there is nothing to offer — the catalog refused, or it
          answered and named nothing — the seeding effect lands `choice` on the
          sentinel, so this reads that one decision rather than working the same
          fact out a second time. A model id needs no catalog, and creating a
          connection downloads nothing, so a listing that failed is not a reason
          to prevent one being configured. */}
      {choice === CUSTOM_MODEL && fixed === undefined && (
        <div className="grid gap-3 sm:grid-cols-2">
          <ModelIdField value={typed.id} onChange={typed.onId} />
          <RevisionField value={typed.revision} onChange={typed.onRevision} />
        </div>
      )}
      {/* Name takes what the two selects leave; below `sm` it has the row to
          itself and the selects share the one under it. */}
      <div className="grid grid-cols-2 items-start gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,1fr)_9rem_7rem]">
        <div className="col-span-2 min-w-0 sm:col-span-1">{nameField}</div>
        {hardware}
      </div>
    </>
  );
}

/**
 * The model field over a served list, in whichever of its four states the
 * query is: reading, refused, offering nothing, or the list.
 */
function ModelField({
  catalog,
  entries,
  choice,
  onChoose,
}: {
  readonly catalog: UseQueryResult<ProviderPage, Error>;
  readonly entries: readonly CuratedEntry[];
  readonly choice: string;
  readonly onChoose: (next: string) => void;
}): JSX.Element {
  const label = useId();
  const groups = groupsOf(entries);
  const chosen = choice === CUSTOM_MODEL ? undefined : entries.find((one) => one.model_id === choice);
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel
        label="Model"
        labelId={label}
        tip={
          // The card answers for the row selected, so it waits for one.
          chosen !== undefined ? (
            <InfoTip label="About the model" title={chosen.hint} testId="info-model" contentTestId="info-model-card">
              Offered by an installed driver and pinned to the revision it declares.
            </InfoTip>
          ) : choice === CUSTOM_MODEL ? (
            <InfoTip label="About the model" title="Any model id" testId="info-model" contentTestId="info-model-card">
              Pinned to the commit you name. It loads if this build has an adapter for it.
            </InfoTip>
          ) : null
        }
      />
      {catalog.isPending ? (
        // Principle 9: a disabled grey list is a question the interface refuses
        // to answer. This says what is happening and leaves the space the list
        // will occupy — and no free model id field either: nothing is known yet
        // about what is offered, and a typed id would move under whoever typed
        // it the moment the list landed.
        <div data-testid="catalog-loading" className="flex flex-col gap-1.5">
          {/* The skeleton is silent. `LoadingState`'s label is `sr-only`, and the
              sentence under it is text a screen reader already reads — labelled,
              the same sentence would be announced twice. */}
          <LoadingState rows={1} label="" />
          <FieldDescription>Reading which models this installation can run…</FieldDescription>
        </div>
      ) : catalog.isError ? (
        <div data-testid="catalog-unavailable">
          <ErrorState code={asApiError(catalog.error).code} message={refusalProse(catalog.error)} onRetry={() => void catalog.refetch()} />
        </div>
      ) : groups.length === 0 ? (
        <FieldDescription data-testid="catalog-empty">
          No installed driver offers a model by name. Install a provider distribution to be offered
          one, or name a model below and pin its revision yourself.
        </FieldDescription>
      ) : (
        <ModelList labelledBy={label} groups={groups} choice={choice} onChoose={onChoose} />
      )}
    </div>
  );
}

/**
 * A connection to an endpoint: where it is, which model and revision it runs,
 * the variable its credential is in, then the name.
 *
 * The offered list is the *local* form's, and only its. An offer is a
 * checkpoint an installed driver can load on this machine and would download;
 * an HTTP connection names whatever the endpoint on the other end runs, which
 * this build never loads and cannot vouch for.
 */
function RemoteFields({
  fixed,
  typed,
  endpoint,
  onEndpoint,
  credentialEnv,
  onCredentialEnv,
  nameField,
}: {
  readonly fixed: Connection | undefined;
  readonly typed: Typed;
  readonly endpoint: string;
  readonly onEndpoint: (next: string) => void;
  readonly credentialEnv: string;
  readonly onCredentialEnv: (next: string) => void;
  readonly nameField: ReactNode;
}): JSX.Element {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="connection-endpoint"
          label="Endpoint URL"
          className="sm:col-span-2"
          placeholder="https://models.example/v1/predict"
          value={endpoint}
          onChange={onEndpoint}
          tip={
            <InfoTip label="About the endpoint URL" title="Where each request goes" testId="info-endpoint">
              A server that answers VisionSet’s inference contract.
            </InfoTip>
          }
        />
        {fixed !== undefined ? (
          <div className="sm:col-span-2">
            <FixedModel connection={fixed} />
          </div>
        ) : (
          <>
            <ModelIdField value={typed.id} onChange={typed.onId} />
            <RevisionField value={typed.revision} onChange={typed.onRevision} />
          </>
        )}
        <TextField
          id="connection-credential-env"
          label="Credential variable"
          className="sm:col-span-2"
          placeholder="MODELS_TOKEN"
          value={credentialEnv}
          onChange={onCredentialEnv}
          tip={
            <InfoTip
              label="About the credential variable"
              title="A variable’s name, not the secret"
              testId="info-credential-env"
              contentTestId="info-credential-env-card"
            >
              Read where the server runs and sent as a bearer token; the value is never stored. Leave
              empty for none.
            </InfoTip>
          }
        />
      </div>
      {nameField}
    </>
  );
}

/**
 * Every offered checkpoint under its ability, then **Custom model…**, as one
 * radio group.
 *
 * Keyboard-correct the way native radios are: the group is one Tab stop (the
 * selected row, or the first while nothing is), and the arrow keys move the
 * selection and the focus together, wrapping at the ends; Home and End jump.
 * Scrolls inside its own frame and fades only the edge that has more behind it
 * (`vs-scroll-fade-y`), and gives height back on a short window. A 12px well
 * with a 4px inset holds 8px rows.
 */
function ModelList({
  labelledBy,
  groups,
  choice,
  onChoose,
}: {
  readonly labelledBy: string;
  readonly groups: readonly CatalogGroup[];
  readonly choice: string;
  readonly onChoose: (next: string) => void;
}): JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  // In the order the rows are drawn, which is the order the arrows walk.
  const order = [...groups.flatMap((group) => group.entries.map((entry) => entry.model_id)), CUSTOM_MODEL];
  const tabbable = order.includes(choice) ? choice : order[0];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const radios = Array.from(frame.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
    const at = radios.indexOf(event.target as HTMLElement);
    if (at === -1) return;
    const last = radios.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = at === last ? 0 : at + 1;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = at === 0 ? last : at - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    const value = order[next];
    if (value === undefined) return;
    onChoose(value);
    radios[next]?.focus();
  }

  return (
    <div
      ref={frame}
      role="radiogroup"
      aria-labelledby={labelledBy}
      data-testid="connection-model"
      onKeyDown={onKeyDown}
      className="vs-scroll-fade-y flex max-h-[min(17rem,38dvh)] flex-col overflow-y-auto rounded-xl border border-border p-1"
    >
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col">
          <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{group.label}</p>
          {group.entries.map((entry) => (
            <ModelRow
              key={entry.model_id}
              entry={entry}
              selected={choice === entry.model_id}
              tabbable={tabbable === entry.model_id}
              onSelect={() => onChoose(entry.model_id)}
            />
          ))}
        </div>
      ))}
      <div className="mt-1 border-t border-border/70 pt-1">
        <ListRow
          testId={`model-option-${CUSTOM_MODEL}`}
          selected={choice === CUSTOM_MODEL}
          tabbable={tabbable === CUSTOM_MODEL}
          onSelect={() => onChoose(CUSTOM_MODEL)}
          lead={<PencilLine aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} absoluteStrokeWidth />}
        >
          <span className="text-xs">Custom model…</span>
          <span className="text-xs text-muted-foreground">Any model id, at a revision you pin</span>
        </ListRow>
      </div>
    </div>
  );
}

/** One offer: where it comes from, its id, whether it is gated, and what it is for. */
function ModelRow({
  entry,
  selected,
  tabbable,
  onSelect,
}: {
  readonly entry: CuratedEntry;
  readonly selected: boolean;
  readonly tabbable: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  return (
    <ListRow
      testId={`model-option-${entry.model_id}`}
      selected={selected}
      tabbable={tabbable}
      onSelect={onSelect}
      // Every offer a driver names is a hub checkpoint — what a curated entry
      // pins is a Hugging Face commit. Decorative: the id beside it says so.
      lead={<OriginLogo origin="huggingface" className="size-4" decorative />}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-xs text-foreground">{entry.model_id}</span>
        {entry.access_note != null && (
          <Badge variant="quiet" data-testid="gated-badge">
            Gated
          </Badge>
        )}
      </span>
      <span className="truncate text-xs text-muted-foreground" data-testid="model-hint">
        {entry.hint}
      </span>
    </ListRow>
  );
}

/**
 * A row of the model list, as a radio.
 *
 * No hover transition — the pointer sweeps lists, and a fade trailing behind it
 * reads as lag — and press feedback that is a transform only, none under
 * reduced motion.
 */
function ListRow({
  testId,
  selected,
  tabbable,
  onSelect,
  lead,
  children,
}: {
  readonly testId: string;
  readonly selected: boolean;
  readonly tabbable: boolean;
  readonly onSelect: () => void;
  readonly lead: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabbable ? 0 : -1}
      data-testid={testId}
      data-selected={selected || undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none",
        "transition-[scale] duration-100 ease-out active:scale-[0.99] motion-reduce:transition-none",
        "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[selected]:bg-muted",
      )}
    >
      {lead}
      <span className="flex min-w-0 flex-1 flex-col">{children}</span>
      <Check aria-hidden="true" className={cn("size-4 shrink-0 text-foreground", selected ? "opacity-100" : "opacity-0")} strokeWidth={2} />
    </button>
  );
}

/**
 * The model a set-up connection names, as the fact it now is.
 *
 * Where the list would be, so the form keeps its shape: once the weights are
 * here the connection *is* those weights, and a different model is a new
 * connection — which the hint says, in the place the choice used to be.
 */
function FixedModel({ connection }: { readonly connection: Connection }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {/* The primitive's look without a `<label>` pointing at no control. */}
      <Label asChild>
        <span>Model</span>
      </Label>
      <p className="font-mono text-sm break-all" data-testid="connection-model-fixed">
        {connection.model_id} @ {connection.model_revision}
      </p>
      <FieldDescription>
        Set up with these weights, so the model cannot change here. Add a new model to run a
        different one.
      </FieldDescription>
    </div>
  );
}

/**
 * A field's label with its info button right after the text — outside the
 * `<label>`, which may hold no interactive content of its own (`DESIGN.md` →
 * *Info*). `htmlFor` where the label names one control; `labelId` where a
 * group names itself by it.
 */
function FieldLabel({
  label,
  htmlFor,
  labelId,
  tip,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly labelId?: string;
  readonly tip?: ReactNode;
}): JSX.Element {
  return (
    // As tall as the info button whether or not one is drawn, so labels beside
    // each other keep one baseline.
    <div className="flex min-h-7 min-w-0 items-center gap-0.5">
      {htmlFor !== undefined ? (
        <Label htmlFor={htmlFor} id={labelId}>
          {label}
        </Label>
      ) : (
        <Label asChild>
          <span id={labelId}>{label}</span>
        </Label>
      )}
      {tip}
    </div>
  );
}

/** A labelled text input; mono, and never spell-checked — every one holds an identifier. */
function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  tip,
  className,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  readonly tip?: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <FieldLabel label={label} htmlFor={id} tip={tip} />
      <Input
        id={id}
        data-testid={id}
        className="font-mono"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}

function ModelIdField({ value, onChange }: { readonly value: string; readonly onChange: (next: string) => void }): JSX.Element {
  return (
    <TextField
      id="connection-custom-model"
      label="Model id"
      placeholder="org/model"
      value={value}
      onChange={onChange}
      tip={
        <InfoTip label="About the model id" title="The repository’s id" testId="info-model-id">
          As the hub names it — for example facebook/sam3.
        </InfoTip>
      }
    />
  );
}

function RevisionField({ value, onChange }: { readonly value: string; readonly onChange: (next: string) => void }): JSX.Element {
  return (
    <TextField
      id="connection-revision"
      label="Revision"
      placeholder="commit sha"
      value={value}
      onChange={onChange}
      tip={
        <InfoTip label="About the revision" title="A commit, never a branch" testId="info-revision" contentTestId="info-revision-card">
          A moving pointer is not a provenance: the weights checked today are the weights that run
          later.
        </InfoTip>
      }
    />
  );
}

/**
 * The connection's name, with a clash said under it.
 *
 * Unique in the workspace ignoring case is the server's rule and stays its
 * refusal; this only says it before Create, from the list the screen already
 * holds. The clash is said inline rather than in the info card, because it is
 * what keeps Create disabled.
 */
function NameField({
  value,
  onChange,
  clash,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly clash: string | null;
}): JSX.Element {
  const errorId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <FieldLabel
        label="Name"
        htmlFor="connection-name"
        tip={
          <InfoTip label="About the name" title="Unique in this workspace" testId="info-name" contentTestId="info-name-card">
            Case is ignored. It’s how projects and the annotator refer to this model.
          </InfoTip>
        }
      />
      <Input
        id="connection-name"
        data-testid="connection-name"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={clash !== null || undefined}
        aria-describedby={clash === null ? undefined : errorId}
      />
      {clash !== null && (
        <p id={errorId} className="text-xs text-destructive" data-testid="connection-name-taken">
          {clash}
        </p>
      )}
    </div>
  );
}

/**
 * Device and precision, as two selects — each a cell of the row the name
 * leads.
 *
 * The precision select offers only what the device honours, and its card says
 * why the other is missing. Each card answers for the value on screen.
 */
function HardwareFields({
  device,
  precision,
  onDevice,
  onPrecision,
}: {
  readonly device: string;
  readonly precision: Precision;
  readonly onDevice: (next: string) => void;
  readonly onPrecision: (next: Precision) => void;
}): JSX.Element {
  const offered = precisionsFor(device);
  const known = (DEVICES as readonly string[]).includes(device);
  // A row already holding something else — `cuda:1` for a second GPU — keeps
  // its own value as an option, so opening the edit form does not silently
  // reassign it.
  const devices: readonly string[] = known ? DEVICES : [...DEVICES, device];
  return (
    <>
      <div className="flex min-w-0 flex-col gap-1.5">
        <FieldLabel
          label="Device"
          htmlFor="connection-device"
          tip={
            <InfoTip
              label="About the device"
              title={known ? DEVICE_MEANS[device as (typeof DEVICES)[number]] : "A device this build passes through as written"}
              testId="info-device"
              contentTestId="info-device-card"
            >
              Which devices this machine has is answered when the model loads.
            </InfoTip>
          }
        />
        <Select value={device} onValueChange={onDevice}>
          <SelectTrigger id="connection-device" data-testid="connection-device" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {devices.map((one) => (
              <SelectItem key={one} value={one}>
                {DEVICE_LABEL[one as (typeof DEVICES)[number]] ?? one}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <FieldLabel
          label="Precision"
          htmlFor="connection-precision"
          tip={
            <InfoTip label="About the precision" title={PRECISION_MEANS[precision]} testId="info-precision" contentTestId="info-precision-card">
              {offered.includes("fp16")
                ? "fp16 halves the memory and runs faster on CUDA."
                : "Half precision applies on CUDA only — on a CPU or Apple GPU it has no effect."}
            </InfoTip>
          }
        />
        <Select value={precision} onValueChange={(next) => onPrecision(next as Precision)}>
          <SelectTrigger id="connection-precision" data-testid="connection-precision" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {offered.map((one) => (
              <SelectItem key={one} value={one}>
                {one}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

/**
 * What creating this connection commits to, said once, above the buttons.
 *
 * On this machine: nothing is downloaded yet, what the selected model would cost
 * when it is, and — for a gated model — what has to be cleared first and where.
 * At an endpoint: that the weights are never this machine's.
 */
function CommitLine({
  local,
  editing,
  entries,
  modelId,
  revision,
}: {
  readonly local: boolean;
  readonly editing: boolean;
  readonly entries: readonly CuratedEntry[];
  readonly modelId: string;
  readonly revision: string;
}): JSX.Element {
  if (!local) {
    return <p className="text-xs text-muted-foreground">VisionSet calls the endpoint; it never downloads or runs these weights.</p>;
  }
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="commit-line">
      <p className="text-pretty">
        {editing ? "Saving it downloads nothing." : "Creating it downloads nothing."}
        <DownloadSize modelId={modelId} revision={revision} />
      </p>
      <AccessLine entries={entries} modelId={modelId} />
    </div>
  );
}

/**
 * What has to be cleared before this model can be fetched, said before it is.
 *
 * Principle 9: no requirement is discovered by crashing into it. A gated model
 * refuses its download with a sentence naming the remedy, which is the right
 * refusal and still the wrong place to learn it — by then somebody has chosen a
 * model, created a connection and pressed a button. This is the same fact, one
 * step earlier, while the choice is still being made.
 *
 * **Looked up by model id alone, and deliberately not through
 * {@link entryFor}.** That helper answers "is this row showing exactly this
 * offered entry", which compares the revision too — the right question for the
 * list, and the wrong one here. An access gate belongs to the *repository*:
 * pinning some other commit of the same model does not exempt anybody from its
 * terms, so a line that disappeared when the revision was edited would be hiding
 * a requirement that still applies.
 *
 * A model id no installed driver offers gets nothing here, and that is honest
 * rather than a gap — whether an arbitrary repository is gated is not something
 * this build knows before asking, and the refusal is what answers it.
 */
function AccessLine({
  entries,
  modelId,
}: {
  readonly entries: readonly CuratedEntry[];
  readonly modelId: string;
}): JSX.Element | null {
  const access = accessFor(entries, modelId);
  if (access === undefined) return null;
  return (
    <p className="text-pretty" data-testid="model-access">
      {access.note}{" "}
      <a className="vs-link inline-flex items-center gap-0.5 text-foreground underline-offset-2" href={access.href} target="_blank" rel="noreferrer">
        Request access
        <ArrowUpRight className="size-3" strokeWidth={1.75} aria-hidden="true" />
      </a>
    </p>
  );
}

/**
 * What this revision would cost to fetch, beside the control that confirms it.
 *
 * D1's "download size shown before confirming", and the one place a missing local
 * runtime becomes visible in this form. The refusal is rendered **as the server
 * wrote it** — `LOCAL_INFERENCE_UNAVAILABLE` is one of the seven codes
 * `server/errors.py` marks `expose_message`, opting out of the opaque body
 * precisely so the install command reaches a person, and a sentence written
 * here would throw it away.
 *
 * The form stays usable throughout (principle 9): not knowing the size does not
 * stop somebody configuring a connection, because creating one downloads nothing.
 */
function DownloadSize({ modelId, revision }: { readonly modelId: string; readonly revision: string }): JSX.Element | null {
  const size = useDownloadSize(modelId, revision);
  if (modelId === "" || revision === "") return null;
  if (size.isPending) {
    return <span data-testid="size-checking"> Reading the download size…</span>;
  }
  if (size.isError) {
    return <span data-testid="size-unavailable"> {refusalProse(size.error)}</span>;
  }
  const files = size.data.file_count;
  return (
    <span data-testid="size-known">
      {" "}
      The weights are <span className="text-foreground tabular-nums">{bytes(size.data.total_bytes)}</span> across{" "}
      {files.toLocaleString()} {files === 1 ? "file" : "files"}, fetched when you ask.
    </span>
  );
}

/**
 * The morph between the two kinds' fields: `measure` before the kind changes,
 * and the box travels from that height to its new one once the swap has
 * rendered (`morphHeight`).
 *
 * Only a press moves it — `measure` is called from the switch alone — so the
 * catalog arriving, a custom model's fields opening or an error appearing
 * change the height at once, as data does everywhere else. A press mid-flight
 * measures the box where the first flight had got to, and that flight is
 * cancelled before the next one reads its target, so the box turns around
 * from where it is.
 */
function useKindMorph(kind: ConnectionType): { readonly ref: RefObject<HTMLDivElement | null>; readonly measure: () => void } {
  const ref = useRef<HTMLDivElement>(null);
  const from = useRef<number | null>(null);
  const flight = useRef<Flight | null>(null);

  useLayoutEffect(() => {
    const box = ref.current;
    const start = from.current;
    from.current = null;
    if (box === null || start === null) return;
    flight.current?.cancel();
    flight.current = morphHeight(box, start);
  }, [kind]);

  // A flight still running when the dialog closes is stopped with it.
  useEffect(() => () => flight.current?.cancel(), []);

  return {
    ref,
    measure: () => {
      from.current = ref.current?.getBoundingClientRect().height ?? null;
    },
  };
}
