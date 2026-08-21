# Writing a provider

**This is not a public extension API in this release.** The contract described here exists so
that this distribution's own drivers run on it - the point of a plugin architecture is proved by
using it before it is published - and it may change in any release without notice or a migration
path. Nothing here is stable, and nothing here is supported for out-of-tree use yet. It is
written down because somebody working inside this repository, or experimenting alongside it,
needs to be able to read what the contract actually is.

**Installing a provider is trusting its author with code execution in the workers**, exactly as
installing any `pip` package is. Discovery loads the class an entry point names, in the server
process and in every background worker, and calls it. There is no sandbox and there is not going
to be one at this layer: a provider that runs a model has to be able to run arbitrary code by
construction. Install one on the same terms you install anything else from an index.

## Closed capabilities, open providers

A capability is what a connection can be asked for, and the vocabulary is
[`ModelCapability`](../../../../src/visionset/kernel/domain/inference.py) - `point_suggest` and
`text_detect` today. **A provider may serve a capability and can never introduce one.** Each
member exists because a surface renders it, so a capability nothing can draw would be a
connection declaring an ability no caller could use.

What a provider adds is a *driver*: the families it serves, the checkpoints it offers by name,
and the object that answers a request. Which families answer to a capability is therefore a
property of the installation rather than of this release.

## The two protocols

Both live in
[`kernel/ports/provider.py`](../../../../src/visionset/kernel/ports/provider.py) and both are
`@runtime_checkable`, so callers ask with `isinstance` on an *instance* - `issubclass` against a
protocol with data members raises.

**`Provider`** is what every driver satisfies:

| Member | What it is |
| --- | --- |
| `provider_id: str` | What the driver calls itself. Distinct from its entry-point name, which is packaging metadata: two strings, and only this one is the contract |
| `families: Mapping[str, ModelCapability]` | Which `model_type` values this driver serves, and what each may be asked for |
| `curated: tuple[CuratedModel, ...]` | Checkpoints offered by name. Empty is legitimate - a driver that runs whatever it is pointed at curates nothing |
| `build(connection, *, family, workspace_root) -> Runner` | The thing that will answer for this connection |

`families` is a mapping and not a set, and that is the whole derivation guarantee: a family
acquires an adapter and a declared capability in one edit. Declaring the two separately is how a
family comes to run fine while every client filtering on the declaration stops offering it.

`build` is told which family it resolved to rather than working it out. More than one
architecture can answer the same prompt kind while loading through different classes, and a
connection does not always carry the family - it is declared by the snapshot on disk. **`build`
loads nothing**: weights load lazily inside what it returns, so a caller may build one to find
out whether a connection *could* run. What comes back satisfies the port the declared capability
implies - `point_suggest` a
[`PointSegmenter`](../../../../src/visionset/kernel/ports/point_segmenter.py), `text_detect` a
[`ModelProvider`](../../../../src/visionset/kernel/ports/model_provider.py).

**`WeightsSource`** is optional, and a driver whose model runs somewhere else simply is not one:

| Method | What it is |
| --- | --- |
| `price(model_id, model_revision) -> DownloadSize` | What fetching that snapshot would cost, before anybody fetches it. Downloads nothing |
| `family_of(connection, *, cache_dir) -> str` | The family the downloaded snapshot declares, or `""` if it cannot say. Read from disk, never from a network |
| `fetch(connection, *, into, on_bytes=None) -> Path` | Put the weights in that cache and say where they landed |

Three methods on a second protocol rather than three more on the first, because a hosted driver
has nothing to fetch, price or read a family from, and three methods whose only implementation is
a refusal is a shape this repository has already paid for twice.

**It reports and does not record.** Moving a connection to `ready`, storing the observed family
and counting what arrived all stay above this line: a number reported by the thing it describes
is not checkable.

**The shipped hosted driver is `http`**
([`inference/http_provider.py`](../../../../src/visionset/inference/http_provider.py)). It serves
`point_suggest` and `text_detect` — its family names *are* the capability names, because the
family an `http` connection records is the capability its endpoint declared, verbatim — declares no
`WeightsSource`, and builds a runner that speaks the endpoint contract in
[`docs/content/inference.md`](../../inference.md#serving-a-model-over-http-the-endpoint-contract).
Resolution for an `http` connection reads the row and nothing else: the driver it recorded (this
one, unless it names another) and the family `test_endpoint` wrote.

## Refusals come from one tree

Every refusal a driver raises - from `build`, from a runner, from a `WeightsSource` - must derive
from `VisionSetError` in
[`kernel/errors.py`](../../../../src/visionset/kernel/errors.py). An implementation library's
exception reaching a surface is a stack trace where a sentence belongs, on every one of the four
surfaces at once.

A runner handed a prompt kind it does not take raises `UnsupportedPrompt` **naming what it does
support**, and never approximates. A resolver that guesses is wrong invisibly: a point-prompt
model read as a detector refuses a click by saying the model "answers text prompts", which is a
confident sentence about some other model.

## Registering it

A provider is discovered through the `visionset.providers` entry-point group, as an exporter is
through `visionset.formats`. The entry point names a **class**, which discovery calls with no
arguments:

```toml
[project.entry-points."visionset.providers"]
my-driver = "my_package.provider:MyProvider"

[project]
dependencies = ["visionset>=0.0.1b1"]
```

Everything a provider says about itself is read straight after that call, so it must be
answerable before any connection exists and without the optional runtime installed. Import your
model library inside a function, never at module scope.

**The prerelease floor is mandatory while VisionSet is pre-1.0, and getting it wrong looks like a
bug in discovery.** Compatibility is your own `dependencies` pin and nothing else - there is no
version member on the contract - and it is checked *before* the entry point is loaded, so a
driver built against a contract this build no longer speaks refuses at discovery instead of
inside a forward pass. The specifier decides exactly as `pip`'s resolver would, which is the
point: a backstop disagreeing with the thing it backs up would be a second gate. The consequence
is that a prerelease sorts **before** its release, so an ordinary-looking `visionset>=0.0.1`
excludes `0.0.1b2` - the very build you are targeting - and your driver is skipped with a
sentence naming both versions. Write `>=0.0.1b1`.

A distribution that pins nothing is compatible: silence is not a refusal, and the in-tree drivers
ship *as* this distribution and so require nothing of it.

Two more facts about discovery worth knowing before you debug one:

- **The scan is kept for the life of the process.** A driver installed while a server is running
  is not seen until it restarts. That is a deliberate trade - a scan costs about 1.3 ms and a scan
  with `load()` about 11 ms, and a driver's declaration is read per connection row.
- **A family two installed drivers both claim is refused, not arbitrated.** There is no honest
  answer where the build cannot say which one would run it, so the connection needing it refuses
  with a sentence naming both drivers and telling you to uninstall one.

## The smallest driver that works

```python
from collections.abc import Iterator
from pathlib import Path
from typing import Final

from visionset.kernel.domain import (
    AssetSegmentation,
    CuratedModel,
    InferenceConnection,
    ModelCapability,
    PointPrompt,
    PredictionRequest,
)
from visionset.kernel.errors import UnsupportedPrompt


class MySegmenter:
    """Satisfies `PointSegmenter` structurally."""

    @property
    def model_ref(self) -> str:
        return "my-org/my-model@abc123"

    def segment(self, request: PredictionRequest) -> Iterator[AssetSegmentation]:
        if not isinstance(request.prompt, PointPrompt):
            raise UnsupportedPrompt(
                f"{self.model_ref} answers point prompts; it was asked with "
                f"{request.prompt.kind!r}, which it has no way to interpret"
            )
        ...


class MyProvider:
    provider_id: Final = "my-driver"
    families: Final = {"my_model_type": ModelCapability.POINT_SUGGEST}
    curated: Final[tuple[CuratedModel, ...]] = ()

    def build(
        self, connection: InferenceConnection, *, family: str, workspace_root: Path
    ) -> MySegmenter:
        return MySegmenter()
```

`my_model_type` is the string the checkpoint's own `config.json` declares under `model_type`, read
literally out of the snapshot on disk and never resolved through `transformers` - which can only
name a type it registers itself, and would read a third-party family back as `""`. That literal
read is exactly what lets a driver from outside this distribution serve a family nothing here has
heard of.

A curated entry pins a **40-character commit**, never a branch or a tag: an immutable snapshot has
one config, one family and one size, and an entry pinned to a moving pointer would describe
whatever it pointed at last. It carries no size of its own - what a download costs is read live
for the exact pair, ahead of the confirmation.

## Conformance

[`tests/inference/test_provider_conformance.py`](../../../../tests/inference/test_provider_conformance.py)
is one parametrised suite over **whatever is installed**, never over a list of drivers. The three
drivers this distribution ships are its first subjects and are not its subject: a promise made in
a port docstring binds nobody until something checks it on every implementation present.

What it holds a driver to: that it satisfies `Provider` under `isinstance`; that its
`provider_id` is non-blank and unique across the installed set; that `families` is non-empty and
every value is a `ModelCapability` member; that every curated entry names a family its own driver
serves and is pinned to a commit; that declaring `WeightsSource` is all-or-nothing and a driver
that declares it can price a checkpoint it offers; that what `build` returns satisfies the port
its declared capability implies; that a runner refuses a prompt kind it does not take with a
sentence naming what it does support; that every answer carries the `model_ref` that produced it;
that there is exactly one answer per target, in the order asked; and that a driver declaring no
`WeightsSource` is built against a hosted connection and still answers once per target, in order -
the suite runs its own contract-speaking endpoint for that.

**Run it against your own driver by installing your driver, not by injecting a fake.** The suite
derives its subjects from the entry-point group, so a real distribution is picked up
automatically and a test double is not - and a fake is the difference between a suite that is
green and a suite that means something. From a checkout of this repository:

```bash
uv pip install --python .venv -e /path/to/your-driver
uv run --no-sync python -c "from visionset.inference.registry import registered; print(sorted(registered().providers))"
uv run --no-sync pytest tests/inference/test_provider_conformance.py -v
```

The middle line is not optional. Entry-point metadata is recorded at install time, so if your
driver is absent from that list the suite will collect fewer subjects and pass while covering
nothing you wrote.

To get back to a clean environment:

```bash
uv pip uninstall your-driver
uv sync --locked
```

Note the same trap in reverse: after any pull that changes `[project.entry-points]`, the metadata
in `.venv` is stale, `registered().providers` is `{}`, every connection refuses, and nothing in
the source looks wrong. `uv sync` fixes it and `uv run --no-sync` never will.

## Related

[`inference.md`](inference.md) is the package that discovers these and turns a connection into a
running model. [`formats.md`](formats.md) is the same mechanism for exporters, and the precedent
this one follows. [`docs/content/inference.md`](../../inference.md) is the surface a user meets:
connections, why nothing is downloaded on your behalf, and where weights land.
