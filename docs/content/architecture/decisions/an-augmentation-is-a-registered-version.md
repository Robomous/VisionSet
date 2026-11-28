# An augmentation is a registered version

Status: **accepted** ([#1238](https://github.com/Robomous/VisionSet/issues/1238), the foundation
of the augmentation epic [#1237](https://github.com/Robomous/VisionSet/issues/1237)). Implemented
in [`kernel/domain/preprocessing.py`](../../../../src/visionset/kernel/domain/preprocessing.py)
and [`kernel/domain/preprocessing_plan.py`](../../../../src/visionset/kernel/domain/preprocessing_plan.py);
the user-facing description is [Pre-processing](../../preprocessing.md#the-augmentation-registry).

## The rule

**A recipe's augmentation step names one registered `(op, version)`, and a variant's draws are
one sampled plan that every consumer reads.** Four consequences hold together:

- **One registry, extended in place.** `AUGMENT_OPERATIONS` is the single description of what an
  augmentation is: its typed parameters with ranges and defaults, the modalities, geometries and
  trainer tasks it serves, its semantic effect, its loss policy, the built-in drivers that apply
  it and whether a preview can show it. It is keyed by `AugmentOp` and holds at least one version
  of every op; its `geometries` are read from `AUGMENT_GEOMETRIES` rather than restated. A
  capability the registry does not declare is one the operation does not have. A compatibility
  resolver, a surface or a preset reads this registry; none keeps a second list.
- **A registered version is immutable.** A stored recipe names the version it ran, and its hash
  and every variant it drew depend on that version staying what it was. A behaviour change - a new
  default, a new draw, a different sampler - is a new version registered beside the old one, never
  an edit to it.
- **Legacy values are invisible.** `version` and `params` are left out of a step's serialized
  form while they hold their legacy values - version 1, no params - through `exclude_if`, the
  mechanism `ManifestAsset` already uses for fields that arrived later. A recipe written before
  the registry existed therefore keeps its canonical bytes, its `recipe_hash` and every variant
  seed derived from it. The decision is value-based, never construction-based, so a spec spelled
  with `version: 1` and one without it serialize alike.
- **Draws are derived, positionally, and sampled once per plan.** A `VariantPlan` is a function
  of `(recipe, content hash, k)` and nothing else. The geometry transform and the pixel driver
  both read it, so neither draws on its own. The three legacy operations read the fixed words of
  the variant seed they always read (brightness word 1, contrast word 2, `rot90` word 3); an
  operation registered after them reads a `StepStream` derived from the seed and its own
  `(op, version)` under a domain tag, by word index rather than by cursor.

## What it rules out

- A second registry, a capability table kept by a surface, or a capability inferred from which
  branch of the arithmetic happens to handle a case.
- Changing a registered operation's parameters, defaults, draws or semantics in place.
- A field added to `AugmentStep` or `RecipeSpec` that serializes at its default. Every field that
  arrives after a recipe could have been stored is left out of the canonical form at its legacy
  value, or the change is a migration with its own decision.
- A draw from `random`, `secrets`, `numpy`, a clock or any other global source anywhere in the
  kernel domain; a test scans its imports. A draw read from a word another step already reads; a
  new operation's words come from its own stream, so adding, removing or reordering a step never
  re-rolls another.
- A pixel driver drawing its own parameters when the kernel handed it a draw.
- An imaging library in the kernel. The registry describes operations; drivers implement them.

## Why

Every export written so far carries a recipe hash, and every training run a person made from one
carries variants whose pixels and labels were drawn from that hash. A field that changed the
canonical bytes would silently rename every stored recipe; a sampler edited in place would make
a re-export of a published release produce different training data under the same name. Both
failures are quiet: nothing refuses, and the damage is found only when a model trained twice on
"the same" export disagrees with itself.

The geometry transform and the pixel driver used to call the draw functions separately and agree
because they read the same seed words. That holds for three operations, each reading one or two
words it owns. It does not scale to operations with several parameters each, written by different
people: a shared word would correlate two steps, and a reused cursor would let one step's change
re-roll the next. One plan, read by both sides, and one stream per step remove both failure
modes and give a preview and a per-output provenance record a value to show and serialize.

## Settled here, left to later work

The driver port gained an optional `draw` keyword. A driver whose `apply` does not take it is
still called without it and must derive the same draw with `sample_step(step, seed)`; that
compatibility is held by a test. The registry declares `tasks`, `semantics` and `loss` as data
only - deciding whether a recipe fits an export target from them is the compatibility resolver's
job ([#1239](https://github.com/Robomous/VisionSet/issues/1239)), and exposing them on the wire
is [#1240](https://github.com/Robomous/VisionSet/issues/1240). The REST, CLI and MCP bodies still
carry no `version` or `params`; every recipe they accept is version 1 with no params, which is
every recipe the registry can describe today.
