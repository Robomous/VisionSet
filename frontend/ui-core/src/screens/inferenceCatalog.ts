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

import type { Precision } from "../data/inferenceQueries";

export type { Precision };

/** One curated checkpoint: what it is, what it costs, and why you would pick it. */
export interface CuratedModel {
  readonly modelId: string;
  /** The commit verified at curation time. Never a branch — see the module note. */
  readonly revision: string;
  /** The hub's figure for that revision, every file included. */
  readonly totalBytes: number;
  /** One line, the difference between this rung and its neighbours. */
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
 * **Most of them are Apache-2.0 and one is not.** The last rung of the
 * point-prompt ladder is published under its trainer's own licence and behind an
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
        hint: "SAM 3 — a newer architecture, the largest download here, wants a GPU",
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
