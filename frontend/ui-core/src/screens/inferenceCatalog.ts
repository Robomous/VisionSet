/**
 * What the connection form offers, over what the installation serves.
 *
 * The models are the server's answer — every installed driver names the
 * checkpoints it offers by name — and this module is what a form makes of that
 * list: the headings, their order, the model a new connection opens on, and the
 * two lookups a stored connection is read through. A model id hardcoded anywhere
 * in `screens/` is a bug this file exists to make visible.
 *
 * ## Curation guides, it never restricts
 *
 * An offer is a checkpoint a driver has declared it can load, and
 * {@link CUSTOM_MODEL} sits beside them: any model id remains typeable, with its
 * own revision, exactly as before. What the offers buy is that the obvious
 * choices are one click away and each one is known to work, rather than being a
 * name somebody has to already know how to spell.
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
 * `models.test.tsx` holds.
 *
 * ## Where the retired invariants went
 *
 * That an entry pins a commit rather than a branch, and that it says in one line
 * what it is for, are a driver's declaration now:
 * `tests/inference/test_provider_conformance.py` holds every installed driver to
 * both — including drivers this repository did not write, which is the half a
 * list living here could never cover.
 */

import type { KnownMembers } from "../generated/api";
import { SUGGEST_CAPABILITY, type CuratedEntry, type InstalledProvider, type Precision } from "../data/inferenceQueries";

export type { Precision };

/**
 * The select's value for "none of these — let me type one".
 *
 * A sentinel rather than an empty string, because empty is what the field holds
 * before anything is chosen and the two mean different things.
 */
export const CUSTOM_MODEL = "custom";

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
 * `modelCapabilities.ts` puts on the Models page, for the same invariant. This is
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
 * company with `capabilityChips`: an empty chip on the Models page is an invitation
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
