# Writing a pre-processing driver

**This is not a public extension API in this release.** The contract described here exists so
that this distribution's own drivers run on it, and it may change in any release without notice
or a migration path. Nothing here is stable, and nothing here is supported for out-of-tree use
yet. It is written down because somebody working inside this repository, or experimenting
alongside it, needs to be able to read what the contract actually is.

**Installing a driver is trusting its author with code execution in the workers**, exactly as
installing any `pip` package is. Discovery loads the class an entry point names, in the server
process and in every background worker, and calls it. There is no sandbox at this layer.

## What a driver is, and what it is not

A [recipe](../../preprocessing.md) is a value: at most one resize step followed by augmentation
steps, and a number of variants per train-fold image. The kernel owns everything about a recipe
except the pixels. It validates the grammar, hashes the spec, decides which files an export
writes, derives every variant's seed, and moves every annotation
([`kernel/domain/preprocessing_transform.py`](../../../../src/visionset/kernel/domain/preprocessing_transform.py)).
A driver is the pixel engine for one kind of step: it is handed one image's bytes and one step
and answers with the transformed bytes.

**Drivers do pixels only.** A driver that moved annotations would be a second spelling of
arithmetic the kernel already owns, and the two spellings would drift. What keeps a variant's
labels on its pixels is that both sides read the same arithmetic: `canvas_fit` is the one
statement of where letterboxed, filled or centre-cropped content lands, and the per-variant draws come from the kernel's
seed helpers, never from a driver's own random source.

## The port

[`PreprocessingDriver`](../../../../src/visionset/kernel/ports/preprocessing.py) is a
`@runtime_checkable` protocol with one data member and one method, so callers ask with
`isinstance` on an *instance*:

| Member | What it is |
| --- | --- |
| `step_kinds: frozenset[str]` | Which step kinds this driver applies - `{"resize"}`, `{"augment"}`, or both |
| `apply(step, image, *, seed, variant, draw=None) -> bytes` | One image's bytes through one step, in the source's encoding |

`step` is a `ResizeStep` or an `AugmentStep`, the kernel's own models, and a driver reads the
step's fields for what to do: `strategy`, `width`, `height` and `pad_value` for a resize;
`op` and `amount` for an augmentation. `image` is the source bytes as the content store holds
them. `seed` is the variant's digest from `variant_seed` and `variant` its index; variant 0 is
the base image, so a step applied to it returns the bytes untouched apart from orientation and
re-encoding, and a resize reads neither argument because it is deterministic.

**Every draw comes from the kernel's plan.** For an augmentation of variant 1 or later the kernel
passes `draw`: the step's entry in the variant's `VariantPlan` - a `HflipDraw`,
`BrightnessContrastDraw` or `Rot90Draw` - which is the value the geometry transform moved the
labels by, and a driver applies exactly that. A driver whose `apply` takes no `draw` keyword is
still called, without it, and must then derive the same value with `sample_step(step, seed)`,
exported from `visionset.kernel.domain`; the kernel checks the signature the way it checks an
exporter's for `assignment`. A driver that read the seed any other way, or drew from anywhere
else, would put its pixels where the geometry transform did not put the labels. The built-in
`rot90` turns counter-clockwise because the kernel's `_rotated_once` does, and a driver applying
that op must turn the same way. A preview in `showcase` mode samples its plan from
`SHOWCASE_SEED`, so the draws a driver is handed are the steps at their declared strength, and
the port needs no second argument for it.

The step grammar is closed. Which kinds exist, and which augmentation ops, is decided by the
kernel's `Step` union, so a driver applies one of the kinds the kernel already names and cannot
introduce a `crop`; a driver claiming a kind the built-in pair applies replaces it for that kind.

## Instances, never names

The kernel may not import this package - the purity contract forbids `visionset.preprocessing`
for the reason it forbids `visionset.formats` - so it never scans entry points and never resolves
a name. `ReleaseService.export(..., drivers=)` and the preview take a mapping from step kind to
driver *instance*, and whoever composed the call built that mapping.
[`preprocessing/registry.py`](../../../../src/visionset/preprocessing/registry.py) is where the
surfaces build it: `drivers()` scans the group and keys what it finds by every step kind the
driver declares, `pick()` and `driver_for()` resolve one step, and a kind nothing applies is
refused with `PreprocessingDriverNotFound` naming what is installed. Nothing is cached; a driver
installed while a server is running is seen on the next call.

## Registering it

A driver is discovered through the `visionset.preprocessing` entry-point group, as an exporter is
through `visionset.formats`. The entry point names a **class**, which discovery calls with no
arguments:

```toml
[project.entry-points."visionset.preprocessing"]
my-resize = "my_package.driver:MyResizeDriver"
```

The two built-in drivers register the same way, in this repository's own `pyproject.toml`:

```toml
[project.entry-points."visionset.preprocessing"]
pillow-resize = "visionset.preprocessing.pillow:PillowResizeDriver"
pillow-augment = "visionset.preprocessing.pillow:PillowAugmentDriver"
```

`step_kinds` is read straight after that call, so it must be a class attribute or set in a
no-argument constructor, and it must be answerable without the driver's image library loaded.

**The image library is the driver's own.** Pillow is a dependency of this distribution for the
built-in pair in [`preprocessing/pillow/`](../../../../src/visionset/preprocessing/pillow/) and
is used nowhere else; a driver from outside the distribution brings whatever it decodes and
encodes with, declared in its own `dependencies`, and imports it inside the module that needs it
rather than at the entry point's import path. Nothing in the kernel names an image library, which
is what lets a driver use one the kernel has never heard of.

## What a driver promises about bytes

The built-in pair's promise is the one an export report is written against: a JPEG comes back a
JPEG at quality 95 with its chroma subsampling kept, a PNG a lossless PNG, and any other encoding
a PNG; no metadata travels. A driver of your own sets its own encoding policy, and the reader of
its output learns it from the bytes, so say what it is in the driver's docstring.

Byte stability is promised within one environment only. The report records `pillow_version`
because the pixels a resize or an enhancement produces depend on the codec and resampling code
that produced them; a driver that used a different library would make that field describe the
wrong thing, which is a limit of the report's shape in this release rather than of the driver.

## The smallest driver that works

```python
from typing import Final

from visionset.kernel.domain import ResizeStep, ResizeStrategy, Step, StepDraw, canvas_fit


class MyResizeDriver:
    """Satisfies `PreprocessingDriver` structurally."""

    step_kinds: Final = frozenset({"resize"})

    def apply(
        self, step: Step, image: bytes, *, seed: bytes, variant: int, draw: StepDraw | None = None
    ) -> bytes:
        if not isinstance(step, ResizeStep):
            raise TypeError(f"{type(self).__name__} applies resize steps, not {step.kind!r}")
        import my_image_library  # the driver's own, loaded on first use

        source = my_image_library.decode(image)
        if step.strategy is ResizeStrategy.STRETCH:
            result = source.resize(step.width, step.height)
        else:
            fit = canvas_fit(
                source.width,
                source.height,
                strategy=step.strategy,
                target_width=step.width,
                target_height=step.height,
            )
            content = source.resize(fit.content_width, fit.content_height)
            result = my_image_library.canvas(step.width, step.height, grey=step.pad_value)
            result.paste(content, at=(fit.offset_x, fit.offset_y))
        return my_image_library.encode(result, like=source)
```

The canvas arithmetic is the kernel's, read back through `canvas_fit` rather than re-derived, so
the content lands exactly where the geometry transform placed the annotations - a letterbox or a
crop worked out in the driver would be a second spelling that could be half a pixel off. A
negative offset puts part of the content off the canvas: pasting there is the `fill` and
`center_crop` crop, and a library whose paste does not clip must crop the content first. An
augmentation driver applies the `draw` it is handed the same way - `brightness` then `contrast`,
`quarter_turns` counter-clockwise, a mirror for every `hflip` - and samples one with
`sample_step(step, seed)` only when called without it. Which `(op, version)` pairs the built-in
driver applies is its `operations` attribute, held equal to the registry's `drivers` column by a
test.

Every refusal a driver raises derives from `VisionSetError` in
[`kernel/errors.py`](../../../../src/visionset/kernel/errors.py); bytes that do not decode are
`UnsupportedMedia`. An implementation library's exception reaching a surface is a stack trace
where a sentence belongs.

## Admission

[`tests/preprocessing/test_driver_registry.py`](../../../../tests/preprocessing/test_driver_registry.py)
is what discovery holds a driver to, and what a driver of your own has to pass alongside the
built-in pair:

- The class the entry point names, called with no arguments, satisfies `PreprocessingDriver`
  under `isinstance`. A class without `step_kinds` is dropped by the port and never keyed, with
  no error - the same silence a format plugin that fails the port gets.
- Every step kind in `step_kinds` is keyed to the driver that declares it, and a driver declaring
  two kinds appears under both.
- A kind nothing installed applies is refused with `PreprocessingDriverNotFound`, whose message
  and `installed` attribute name the kinds that are, or `none`.
- The suite asserts the built-in pair is what answers `resize` and `augment`, so a driver that
  replaces one of them fails that assertion by design; it is the record of which driver the
  distribution ships for each kind, and a replacement changes that record.

Run it against your own driver by installing the driver, not by injecting a fake. From a checkout
of this repository:

```bash
uv pip install --python .venv -e /path/to/your-driver
uv run --no-sync python -c "from visionset.preprocessing.registry import drivers; print(sorted(drivers()))"
uv run --no-sync pytest tests/preprocessing -v
```

The middle line is not optional: entry-point metadata is recorded at install time, and if your
driver's kinds are absent from that list the suite exercises the built-in pair and nothing you
wrote. After any pull that changes `[project.entry-points]`, the metadata in `.venv` is stale in
the same way, and `uv sync` is what refreshes it. To get back to a clean environment:

```bash
uv pip uninstall your-driver
uv sync --locked
```

## Related

[`formats.md`](formats.md) is the same mechanism for exporters and the precedent this group
follows; [`providers.md`](providers.md) is the third entry-point group, for model drivers.
[`docs/content/preprocessing.md`](../../preprocessing.md) is the surface a user meets: what a
recipe is, how variants are seeded, and what each surface offers.
