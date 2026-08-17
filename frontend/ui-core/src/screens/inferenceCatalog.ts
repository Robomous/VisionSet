/**
 * What the connection form offers: the curated models, the devices, the precisions.
 *
 * **One module, because a second one is how a list starts disagreeing with
 * itself.** The form reads this and nothing else, so adding a model is an entry
 * here and no other edit — and a model id hardcoded anywhere in `screens/` is a
 * bug this file exists to make visible.
 *
 * ## Curation guides, it never restricts
 *
 * Every entry below is a checkpoint this build has an adapter for, and
 * {@link CUSTOM_MODEL} is beside them: any model id remains typeable, with its
 * own revision, exactly as before. What curation buys is that the six obvious
 * choices are one click away and each one is known to work, rather than being a
 * name somebody has to already know how to spell.
 *
 * ## Each entry is verified rather than hoped for
 *
 * Before an entry lands here, three things are established against the locked
 * `transformers` and the publishing hub: the `model_type` its config declares
 * lands in the resolver's supported family sets (`inference/providers.py`), the
 * revision is a real commit, and the download size is the hub's own figure for
 * that revision. A candidate that fails any of them is dropped rather than
 * shipped with a hopeful comment.
 *
 * **The revision is a commit hash and never `main`.** The form's own helper text
 * says a moving pointer is not a provenance; a curated list that pinned a branch
 * would be saying it while doing the opposite, and the size beside the entry
 * would describe whatever the branch pointed at last week.
 *
 * **The size is safe to hold as a constant** for the same reason: a pinned
 * revision is an immutable set of files, so the number cannot go stale. It is
 * what the list shows while somebody is still choosing; the line under the field
 * reads the same fact live from the size endpoint, and that is the one a person
 * confirms a download against.
 *
 * ## The two closed vocabularies
 *
 * `device` and `precision` are the kernel's vocabularies
 * (`kernel/domain/inference.py`), and the kernel is what refuses a pair outside
 * them — including `cpu` with `fp16`, which both local adapters silently drop.
 * What lives here is the *offering*: which members a form puts on screen and in
 * what order. That is not the hand-mirror `ui-capabilities` bans — that rule is
 * about `allowed_actions`, which no field-level shape can carry — and the
 * refusal still arrives from the server and still renders as prose, which
 * `inference.test.tsx` holds.
 */

import type { KnownMembers } from "../generated/api";
import { SUGGEST_CAPABILITY, type CuratedEntry, type InstalledProvider, type Precision } from "../data/inferenceQueries";

export type { Precision };

/** One curated checkpoint: what it is, what it costs, and why you would pick it. */
export interface CuratedModel {
  readonly modelId: string;
  /** The commit verified at curation time. Never a branch — see the module note. */
  readonly revision: string;
  /** The hub's figure for that revision, every file included. */
  readonly totalBytes: number;
  /**
   * One line saying what this entry needs, in its own terms.
   *
   * **No word whose referent is somewhere else.** "Newer", "different", "other",
   * "another", "improved", "latest" all point at something the reader is expected
   * to already have in mind, and here there is nothing for them to point at: this
   * product has no released history to be newer than, and {@link CURATED_MODELS}
   * is grouped by the question a model answers rather than ranked, so there is no
   * position in a list for an entry to be different *from*. A reader meets one of
   * those words as a comparison whose first half is missing.
   *
   * Hardware and speed are the axes that survive being read alone. A ladder of
   * rungs from one family may compare within itself, because the rungs are on
   * screen together and the ordering is real; an entry that is nobody's rung says
   * only what it is.
   *
   * The size and the access requirement are already rendered beside this line, so
   * a hint restating either spends its one line saying nothing new.
   */
  readonly hint: string;
  /**
   * What has to be cleared before this entry can be downloaded at all.
   *
   * Absent on an entry anybody can fetch, which is most of them. Where it is
   * present the form states it **before** the download is offered, because a
   * requirement discovered by pressing a button and reading a refusal is a
   * requirement the interface knew about and did not say.
   */
  readonly access?: {
    /** One sentence: what must be accepted, and under whose terms. */
    readonly note: string;
    /** Where that is done. */
    readonly href: string;
  };
}

/** A family of curated models, named by the question its models answer. */
export interface CuratedGroup {
  readonly label: string;
  readonly models: readonly CuratedModel[];
}

/**
 * The models this build has an adapter for, grouped by what you ask them.
 *
 * Every entry is published by the people who trained it, which is the
 * neutral-sources rule this product configures itself under: a curated list
 * points at originals, never at a re-publisher or a mirror.
 *
 * **Most of them are Apache-2.0 and one is not.** `facebook/sam3` is published
 * under its trainer's own licence and behind an
 * access gate, and it is offered anyway because the alternative is worse: leaving
 * it out does not spare anybody the terms, it only means the people who want it
 * have to find the model id somewhere else and type it in, having read nothing.
 * Curating it is what puts {@link CuratedModel.access} on screen before a
 * download is offered. Nothing about the licence reaches this product's own: the
 * adapter code is ours and stays Apache-2.0, and the weights are fetched by the
 * person using it, from the publisher, after they have accepted the terms
 * themselves — this list never redistributes anything.
 *
 * The ladders are complete on purpose. Offering only a middle rung would make
 * the choice between "runs on this laptop" and "as accurate as this build gets"
 * something a person has to leave the form to discover.
 */
export const CURATED_MODELS: readonly CuratedGroup[] = [
  {
    label: "Interactive segmentation (point prompts)",
    models: [
      {
        modelId: "facebook/sam2.1-hiera-tiny",
        revision: "de431c4043854a71d8101e17995dfe596bf101a5",
        totalBytes: 311_949_047,
        hint: "tiny — fastest, comfortable on a CPU",
      },
      {
        modelId: "facebook/sam2.1-hiera-small",
        revision: "ee5bba1d82bb8749febdf90f45e84b687142ba03",
        totalBytes: 368_754_000,
        hint: "small — a little more accurate, still light",
      },
      {
        modelId: "facebook/sam2.1-hiera-base-plus",
        revision: "b7320756a13354e7530a63935656d35b2f91a290",
        totalBytes: 647_115_465,
        hint: "base-plus — the balanced default",
      },
      {
        modelId: "facebook/sam2.1-hiera-large",
        revision: "665f8e2ad61cf5f53d65644ff27c8ee525124610",
        totalBytes: 1_796_013_511,
        hint: "large — the most accurate, wants a GPU",
      },
      {
        modelId: "facebook/sam3",
        revision: "3c879f39826c281e95690f02c7821c4de09afae7",
        // The repository publishes its weights twice, once as a checkpoint and
        // once as safetensors, and fetching a revision fetches all of it. So this
        // is about twice the size of the model it installs, and it is the figure
        // that belongs here: what lands on the disk, not what gets loaded.
        totalBytes: 6_895_093_624,
        hint: "wants a GPU",
        access: {
          note: "Meta publishes these weights under the SAM License and grants access by request. Ask for it, then set HF_TOKEN before downloading.",
          href: "https://huggingface.co/facebook/sam3",
        },
      },
    ],
  },
  {
    label: "Text-prompt detection",
    models: [
      {
        modelId: "IDEA-Research/grounding-dino-tiny",
        revision: "a2bb814dd30d776dcf7e30523b00659f4f141c71",
        totalBytes: 1_382_224_246,
        hint: "tiny — fastest, comfortable on a CPU",
      },
      {
        modelId: "IDEA-Research/grounding-dino-base",
        revision: "12bdfa3120f3e7ec7b434d90674b3396eccf88eb",
        totalBytes: 1_870_353_436,
        hint: "base — more accurate, wants a GPU",
      },
    ],
  },
];

/**
 * The select's value for "none of these — let me type one".
 *
 * A sentinel rather than an empty string, because empty is what the field holds
 * before anything is chosen and the two mean different things.
 */
export const CUSTOM_MODEL = "custom";

/** Every curated entry, flat, for a lookup by model id. */
export const CURATED_BY_ID: ReadonlyMap<string, CuratedModel> = new Map(
  CURATED_MODELS.flatMap((group) => group.models).map((model) => [model.modelId, model]),
);

/**
 * What a new local connection starts on.
 *
 * The balanced rung of the point-prompt ladder, and the pinned successor of the
 * single model this form suggested before there was a list — so the default a
 * person meets does not move under them, it only stops being a branch.
 */
export const DEFAULT_MODEL: CuratedModel = CURATED_BY_ID.get("facebook/sam2.1-hiera-base-plus")!;

/**
 * The entry a stored connection is showing, or `undefined` if it is a custom one.
 *
 * Both halves are compared. A row naming a curated model at a *different*
 * revision is a custom connection wearing a familiar name, and showing it as the
 * curated entry would misreport which weights it runs.
 */
export function curatedEntry(modelId: string, revision: string): CuratedModel | undefined {
  const found = CURATED_BY_ID.get(modelId);
  return found !== undefined && found.revision === revision ? found : undefined;
}

/**
 * The devices a form offers, in the order it offers them.
 *
 * `mps` is Apple Silicon's GPU, and it is one entry rather than a platform
 * branch: which devices a machine actually has is answered where the model is
 * loaded, not by a form guessing from a user agent.
 */
export const DEVICES = ["cpu", "cuda", "mps"] as const;

/**
 * The precisions that are honoured on that device — the kernel's
 * `precisions_for`, offering-side.
 *
 * Half precision is CUDA-only in both local adapters, so `cpu` + `fp16` is not a
 * slower run but a setting with no effect that the row would go on displaying as
 * though it had one. `mps` answers the same way and for its own reason: Metal has
 * no float64 and an inconsistent bfloat16, so full precision is the only format
 * that behaves the same on every machine offering the device. A machine
 * addressing a second GPU writes `cuda:1`, which is not a member of
 * {@link DEVICES} and is still a CUDA device — hence the prefix test rather than
 * an equality against `"cuda"`, which is also what leaves every non-CUDA device
 * on `fp32` without naming each one.
 */
export function precisionsFor(device: string): readonly Precision[] {
  return device.startsWith("cuda") ? ["fp16", "fp32"] : ["fp32"];
}

/**
 * The precision to select when the device changes under an existing choice.
 *
 * Keeps what was chosen when it survives the move, so switching to `cuda` and
 * back does not quietly rewrite somebody's `fp32`. Falls to the first offered
 * member when it does not — which is the whole of "a curated model on `cpu`
 * defaults to `fp32`".
 */
export function precisionOn(device: string, current: Precision): Precision {
  const offered = precisionsFor(device);
  return offered.includes(current) ? current : offered[0]!;
}

/**
 * The heading each ability gets in the model select.
 *
 * A `Record` over the vocabulary's *known* members, so a member added to the
 * kernel fails this build until its heading exists — the same enforcement
 * `inferenceSections.ts` puts on the dashboard, for the same invariant. This is
 * the copy a plugin does not ship: a driver declares which ability it serves and
 * never how that ability is named on screen.
 */
const CAPABILITY_GROUP: Record<KnownMembers["ModelCapability"], string> = {
  point_suggest: "Interactive segmentation (point prompts)",
  text_detect: "Text-prompt detection",
};

/** One heading in the select, and the offers under it. */
export interface CatalogGroup {
  /** The capability value the group holds. */
  readonly key: string;
  readonly label: string;
  readonly entries: readonly CuratedEntry[];
}

/**
 * The model this form opens on when the installation offers it.
 *
 * A product decision and not a flag on the contract: a `default` member would let
 * whoever ships a driver decide what a person meets first. It is the balanced rung
 * of the point-prompt ladder — the pinned successor of the single model this form
 * suggested before there was a list — so the default does not move under anybody.
 */
export const PREFERRED_MODEL_ID = "facebook/sam2.1-hiera-base-plus";

/** Every offer the installation makes, in the order it made them. */
export function entriesOf(providers: readonly InstalledProvider[]): readonly CuratedEntry[] {
  return providers.flatMap((provider) => provider.curated);
}

/**
 * The offers under their headings, in the order the dashboard reads abilities.
 *
 * A group with nothing in it is **not** rendered, which is where this parts
 * company with `sectionsOf`: an empty section of the dashboard is an invitation
 * to configure something, and an empty group in a select is a heading over
 * nothing.
 *
 * An ability this build has no heading for is shown under its own value rather
 * than dropped. The capability vocabulary is open, so a newer server or an
 * installed driver may name one — and hiding it would hide a model the
 * installation can actually run.
 */
export function groupsOf(entries: readonly CuratedEntry[]): readonly CatalogGroup[] {
  const held = new Map<string, CuratedEntry[]>();
  for (const entry of entries) {
    const bucket = held.get(entry.capability);
    if (bucket === undefined) held.set(entry.capability, [entry]);
    else bucket.push(entry);
  }

  const groups: CatalogGroup[] = [];
  for (const [capability, label] of Object.entries(CAPABILITY_GROUP)) {
    const under = held.get(capability);
    if (under !== undefined) groups.push({ key: capability, label, entries: under });
  }
  // Then whatever was offered that this build cannot name, in the order the
  // catalog first mentions it — a `Map` keeps insertion order, so the ordering is
  // the installation's rather than an alphabetisation nobody asked for.
  for (const [capability, under] of held) {
    if (capability in CAPABILITY_GROUP) continue;
    groups.push({ key: capability, label: capability, entries: under });
  }
  return groups;
}

/**
 * What a new local connection opens on, or `undefined` if nothing fits.
 *
 * {@link PREFERRED_MODEL_ID} when the installation offers it, and otherwise the
 * first offer that answers a point prompt — because the one surface that
 * consumes a suggestion is the editor's suggest tool, and opening on a model
 * nothing in the app can ask would be a default that leads nowhere.
 */
export function defaultEntry(entries: readonly CuratedEntry[]): CuratedEntry | undefined {
  const preferred = entries.find((entry) => entry.model_id === PREFERRED_MODEL_ID);
  if (preferred !== undefined) return preferred;
  return entries.find((entry) => entry.capability === SUGGEST_CAPABILITY);
}

/**
 * The offer a stored connection is showing, or `undefined` if it is a custom one.
 *
 * Both halves are compared. A row naming an offered model at a *different*
 * revision is a custom connection wearing a familiar name, and showing it as the
 * offered entry would misreport which weights it runs.
 */
export function entryFor(
  entries: readonly CuratedEntry[],
  modelId: string,
  revision: string,
): CuratedEntry | undefined {
  return entries.find(
    (entry) => entry.model_id === modelId && entry.model_revision === revision,
  );
}

/**
 * What must be cleared before this model can be fetched, and where.
 *
 * **By model id alone, and deliberately not through {@link entryFor}.** An access
 * gate belongs to the repository: pinning some other commit of the same model
 * exempts nobody from its terms, so a line that disappeared when the revision was
 * edited would be hiding a requirement that still applies.
 *
 * Both halves or neither. Either alone is a requirement a form cannot finish
 * stating before it offers the download, so it states none of it and lets the
 * refusal answer.
 */
export function accessFor(
  entries: readonly CuratedEntry[],
  modelId: string,
): { readonly note: string; readonly href: string } | undefined {
  const entry = entries.find((one) => one.model_id === modelId);
  if (entry?.access_note == null || entry.access_url == null) return undefined;
  return { note: entry.access_note, href: entry.access_url };
}
