/**
 * What the Inference dashboard is organised by: one section per ability a model
 * can be asked for, and the copy that says what each one enables.
 *
 * ## A section comes from the wire, never from a model's name
 *
 * `capabilities` on a connection is **weights-derived** — the server reads the
 * downloaded model's own config and maps its family to a capability — so which
 * section a connection lands in is the server's answer. A client that grouped by
 * model id would be guessing about weights it has never seen, and would guess
 * wrong the first time somebody pins a checkpoint the curated list does not name.
 *
 * It is a different question from `allowed_actions`, which is state-derived and
 * decides what a *row* may offer. This module answers *where the row goes*; it
 * never answers what the row may do.
 *
 * ## The copy is one record, so a new capability is one entry
 *
 * {@link CAPABILITY_COPY} is keyed by the vocabulary's *known* members — the wire
 * type admits a value a newer server added, `KnownMembers` does not — so a member
 * added to the kernel's vocabulary fails this build until its entry exists: the
 * zero-orphaned-capabilities invariant, enforced where a section is decided.
 * Sections render in this record's own declaration order.
 *
 * ## Two things still get a section without an entry
 *
 * A capability value this build never compiled against — a newer server, or a
 * driver it does not ship — gets a generic section built from the value itself,
 * because nothing the wire declares may be invisible. The capability vocabulary is
 * declared open in the contract, so the generated response check passes such a
 * value rather than refusing the whole listing over it: this is a path a running
 * app takes, not only a safety net. The layer that decides *whether a value
 * arrives* and the layer that decides *what it looks like* are still not the same
 * layer, and only one of them is this one.
 *
 * And a connection declaring *no* capability gets one too. A row belonging to no
 * section would be a connection nobody could download, edit or delete.
 *
 * That section is one heading over connections that are silent for **different
 * reasons**, which is why its prose is derived rather than fixed: the weights have
 * not been downloaded, or they are here and nothing came of them, or it is an
 * endpoint whose model this workspace never loads. See {@link reasonFor}. A single
 * sentence naming the commonest cause asserted it about all of them, and told
 * somebody whose download had finished that it had not.
 */

import type { KnownMembers } from "../generated/api.js";
import type { Connection } from "../data/inferenceQueries";

/** How a section reads when it holds nothing. */
export type SectionEmpty =
  | {
      /** Something can be added, and the CTA names what. */
      readonly kind: "invite";
      readonly title: string;
      readonly body: string;
      readonly cta: string;
    }
  | {
      /**
       * Nothing in the app consumes this yet, so there is nothing to invite.
       *
       * One line of prose and no control: a button into a surface that does not
       * exist is the dead control design principle 9 forbids, and inviting
       * somebody to configure a connection nothing can use is the same offer
       * wearing a friendlier label.
       */
      readonly kind: "describe";
      readonly line: string;
    };

/** What a section says about itself, whatever it holds. */
export interface CapabilityCopy {
  readonly title: string;
  /** One line: the ability, and the surface that asks for it. */
  readonly purpose: string;
  readonly empty: SectionEmpty;
}

/**
 * Every capability this build can describe, in the order the dashboard shows them.
 *
 * A `Record` over the generated union rather than an array, so the totality is
 * the compiler's to check. Declaration order is render order.
 */
const CAPABILITY_COPY: Record<KnownMembers["ModelCapability"], CapabilityCopy> = {
  point_suggest: {
    title: "Suggest a region from clicks",
    purpose:
      "The editor's suggest tool sends the points somebody clicks and draws back what the model proposes.",
    empty: {
      kind: "invite",
      title: "Add a connection the suggest tool can use",
      body: "A point-prompt model turns a click into an outline, so an annotator confirms a region instead of tracing one.",
      cta: "Add a point-prompt connection",
    },
  },
  text_detect: {
    title: "Find objects from a description",
    purpose:
      "A batch's schema becomes the prompt: the model is asked for each class it declares, and what it finds enters the batch awaiting review.",
    empty: {
      kind: "invite",
      title: "Add a connection that answers words",
      body: "A text-prompt model labels a batch before anybody opens it, so an annotator reviews a draft instead of starting from an empty frame.",
      cta: "Add a text-prompt connection",
    },
  },
};

/** The section a connection that declares nothing lands in. */
export const UNDECLARED = "undeclared";

/**
 * Why a connection has nothing to declare — read off the row, never guessed.
 *
 * Three things land a connection here and they do not share a remedy, so one
 * sentence covering all three is untrue of most of them. `setup_state` is the
 * field that separates the first two: it is cleared as the *last* step of a
 * successful download, so `ready` means the weights are on disk and blaming the
 * download for the silence is a sentence about somebody else's connection.
 *
 * The third and fourth causes are one clause on purpose. A model whose weights
 * are here and still declares nothing either did not say what it is, or names a
 * family no installed driver serves — and the wire cannot tell those apart,
 * because both answer with an empty `capabilities`. Naming both remedies is the
 * honest reading of what the client actually knows; picking one would be the
 * guess this dashboard removes everywhere else.
 */
type UndeclaredReason = "awaiting-weights" | "nothing-came-of-them" | "endpoint";

function reasonFor(connection: Connection): UndeclaredReason {
  if (connection.connection_type === "http") return "endpoint";
  return connection.setup_state === "ready" ? "nothing-came-of-them" : "awaiting-weights";
}

/** One sentence per reason, in the order they are worth reading. */
const UNDECLARED_BECAUSE: Readonly<Record<UndeclaredReason, string>> = {
  "awaiting-weights":
    "What a model answers is read from its own weights, so a connection cannot say until they have been downloaded.",
  "nothing-came-of-them":
    "A connection whose weights are already here and still declares nothing either did not say which model it is, or names a family no installed driver serves.",
  endpoint:
    "An endpoint keeps its answer to itself: this workspace never loads the model behind one.",
};

const UNDECLARED_ORDER: readonly UndeclaredReason[] = [
  "awaiting-weights",
  "nothing-came-of-them",
  "endpoint",
];

/**
 * What the undeclared section says about the rows it actually holds.
 *
 * Derived rather than constant, which is the whole of the fix: the section is one
 * heading over connections silent for different reasons, and a fixed sentence
 * asserted the commonest one about all of them.
 */
function undeclaredCopy(connections: readonly Connection[]): CapabilityCopy {
  const held = new Set(connections.map(reasonFor));
  return {
    title: "No ability declared yet",
    purpose: UNDECLARED_ORDER.filter((reason) => held.has(reason))
      .map((reason) => UNDECLARED_BECAUSE[reason])
      .join(" "),
    empty: { kind: "describe", line: "Every connection says what it answers." },
  };
}

/** A value that arrived on the wire and this build has no copy for. */
function unknownCopy(capability: string): CapabilityCopy {
  return {
    title: capability,
    purpose:
      "Something in this workspace declares this ability and this build has no description for it. The connections below serve it, and what each one offers is still the wire's answer.",
    empty: { kind: "describe", line: "Nothing declares it." },
  };
}

/** One heading, its prose, and the connections under it. */
export interface ConnectionSection {
  /** The capability value, or {@link UNDECLARED}. */
  readonly key: string;
  readonly title: string;
  readonly purpose: string;
  readonly empty: SectionEmpty;
  /** `false` for a capability this build had no copy for. */
  readonly known: boolean;
  readonly connections: readonly Connection[];
}

/**
 * The dashboard's sections, in render order, for the connections it was given.
 *
 * Described capabilities always come back, holding nothing if nothing serves
 * them: an ability the app consumes is a thing to invite a connection for, and a
 * section that vanished when empty would make a bare workspace and a configured
 * one render alike (design principle 6). The two derived kinds come back only
 * when something is in them — there is no invitation to make and no ability to
 * describe until a connection names one.
 *
 * A connection serving several capabilities appears under each of them. It is one
 * row of one workspace either way: the detail, edit and delete surfaces are the
 * screen's, and every copy re-renders off the same cached list.
 */
export function sectionsOf(connections: readonly Connection[]): readonly ConnectionSection[] {
  const held = new Map<string, Connection[]>();
  const undeclared: Connection[] = [];
  for (const connection of connections) {
    if (connection.capabilities.length === 0) {
      undeclared.push(connection);
      continue;
    }
    for (const capability of connection.capabilities) {
      const bucket = held.get(capability);
      if (bucket === undefined) held.set(capability, [connection]);
      else bucket.push(connection);
    }
  }

  const sections: ConnectionSection[] = Object.entries(CAPABILITY_COPY).map(
    ([capability, copy]) => ({
      key: capability,
      ...copy,
      known: true,
      connections: held.get(capability) ?? [],
    }),
  );
  // Then whatever was declared that this build cannot name, in the order the
  // list first mentions it — a `Map` keeps insertion order, so the ordering is
  // the workspace's rather than an alphabetisation nobody asked for.
  for (const [capability, rows] of held) {
    if (capability in CAPABILITY_COPY) continue;
    sections.push({ key: capability, ...unknownCopy(capability), known: false, connections: rows });
  }
  if (undeclared.length > 0) {
    sections.push({
      key: UNDECLARED,
      ...undeclaredCopy(undeclared),
      known: true,
      connections: undeclared,
    });
  }
  return sections;
}
