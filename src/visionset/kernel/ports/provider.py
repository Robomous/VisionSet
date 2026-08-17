# usage: from visionset.kernel.ports import Provider, WeightsSource
"""What a driver declares about itself, and what it builds when a connection asks.

``ModelProvider`` and ``PointSegmenter`` describe *asking a model something*. This
describes the thing that knows which models it can be asked about — the object a
distribution registers, and the one the composition root resolves a connection
through.

**Closed capabilities, open providers.** A driver may serve a capability the
application already defines and can never introduce one: :data:`families` maps a
model family onto a member of ``ModelCapability``, which is the kernel's own
closed vocabulary. A capability arrives with the VisionSet release that ships the
surface rendering it, never with a plugin — which is what keeps one generic screen
able to render any provider without a plugin shipping frontend code.

## Why this port may name a filesystem when the model ports may not

``tests/architecture/test_model_provider_port.py`` bans ``pathlib`` from the two
ports a model is asked through, because a ``Path`` in one of those signatures is a
claim about a filesystem shared with whatever answers — and the whole point of
those ports is that the answer may come from across a network.

Nothing here crosses a network. A ``Provider`` is discovered, described and asked
to build **in this process**, and what it builds is where the network question
starts. So this is ``Exporter``'s shape rather than ``ModelProvider``'s: a local
plugin the composition root holds, which is why ``Exporter`` names a ``dest``
``Path`` and is likewise not on that file's list.

## Discovery, and the objection it answers

Implementations are found through the ``visionset.providers`` entry-point group,
as ``Exporter`` and ``Importer`` are found through ``visionset.formats``.

The reading this replaces was that a provider is not plugin-shaped, because an
adapter is built from a user-created connection and one discovered by entry point
*"would have nothing to be instantiated from"*. That was right about the object it
described and is not what an entry point yields here. It yields a descriptor that
declares what it serves and builds a runner when a connection asks; the connection
remains the registry, exactly as before. What discovery supplies is the driver
table resolution consults, in place of a set of family names written into this
build.

The other half of that objection stands and constrains everything below:
installing a provider must not give a workspace the ability to predict. It does
not. Nothing is fetched, nothing is loaded, and every existing connection runs
exactly what it ran before — a driver becomes *reachable*, and a model does not
become *present*.

## What a provider owes

- It **describes itself without importing anything heavy.** A base install starts
  a server and a worker with the optional model runtime absent, and it must be
  able to list what is installed. A provider that imports an array library to say
  its own name breaks that.
- It **refuses rather than approximates**, in prose naming what it does support. A
  points-prompted model handed words has not been asked a harder question; it has
  been asked a different one.
- It owes **no** thread safety, no caching and no persistence. The composition
  root keeps what it builds.
"""

from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import (
    CuratedModel,
    DownloadSize,
    InferenceConnection,
    ModelCapability,
)
from visionset.kernel.ports.model_provider import ModelProvider
from visionset.kernel.ports.point_segmenter import PointSegmenter

type Runner = ModelProvider | PointSegmenter
"""Either kind of thing a connection can resolve to.

A union rather than one widened port, because the two answer different questions:
a detector is asked what it sees and answers in boxes, a segmenter is asked what
is under a point and answers in pixels. Resolution is the same for both — a
connection names a model, and its family decides which adapter is built — so it is
only the return type that has to admit both, and the caller narrows with
``isinstance`` on the protocol it needs.

Declared here rather than beside the resolver because it is kernel vocabulary:
both members are kernel ports, and the thing that produces one is declared in this
file.
"""


@runtime_checkable
class Provider(Protocol):
    """A driver: what it serves, what it offers by name, and what it builds.

    **Constructed with no arguments**, on ``Exporter``'s terms — discovery does
    ``entry_point.load()()`` and then reads the declarations below. Everything a
    provider says about itself must therefore be answerable before any connection
    exists, before any weights are on disk, and without the optional runtime
    installed.

    ``@runtime_checkable`` so the thing discovery built can be checked against
    this on an *instance*. Note that is the only check available: ``issubclass``
    against a protocol carrying data members raises, which is why
    ``formats/registry.py`` filters its shared group with ``isinstance`` too.
    """

    #: What this driver calls itself, for a refusal to name and a listing to key
    #: on. Distinct from its entry-point name, which is packaging metadata the
    #: distribution picks: two strings, and only this one is the contract.
    provider_id: str

    #: Which model families this driver serves, and what each one can be asked
    #: for.
    #:
    #: **A mapping rather than a set, and that is the whole derivation
    #: guarantee.** Declaring the families and declaring the capabilities
    #: separately is how a family acquires an adapter and never acquires a
    #: declaration — leaving a model that runs perfectly while being invisible to
    #: every client that filters on what a connection says it can do. Saying it
    #: once means the adapter and the declaration are the same edit.
    #:
    #: The values are members of a closed vocabulary a provider may reference and
    #: cannot extend. That is the capability rule expressed as a type rather than
    #: as a review comment.
    families: Mapping[str, ModelCapability]

    #: Checkpoints this driver offers by name, for a form to put on screen.
    #:
    #: Empty is a legitimate answer: a driver that runs whatever it is pointed at
    #: curates nothing, and a connection may still name any model at any revision.
    #: Each entry's ``family`` must be one of :data:`families`, which is what
    #: files it under the question its model answers.
    curated: tuple[CuratedModel, ...]

    def build(self, connection: InferenceConnection, *, workspace_root: Path) -> Runner:
        """The thing that will answer for this connection.

        **Loads nothing.** The weights load lazily, inside what this returns, so a
        caller may build one purely to find out whether a connection *could* run.
        That is what makes the refusals below worth raising early rather than
        somewhere inside a first prediction.

        What comes back satisfies the port the declared capability implies: a
        family mapped to ``point_suggest`` builds a ``PointSegmenter``, one mapped
        to ``text_detect`` builds a ``ModelProvider``. A provider is held to that
        by the conformance suite rather than by this sentence.

        Raises:
            VisionSetError: this connection cannot be run — weights that are not
                on this machine, a runtime that is not installed, a configuration
                this driver cannot serve. It **must** raise from that tree rather
                than letting an implementation library's exception out, so every
                surface renders a sentence instead of a stack trace.
        """
        ...


@runtime_checkable
class WeightsSource(Protocol):
    """Where a driver's weights come from, for a driver whose weights are local.

    **A second protocol rather than three more members on the first.** A hosted
    driver has nothing to fetch, nothing to price and no config on a disk to read
    a family from; giving it three methods whose only implementation is a refusal
    is the shape this repository has already paid for twice, with a precision
    value accepted and silently dropped and with a request field published and
    then ignored. A provider either does this or does not, and the call site asks
    with ``isinstance``, exactly as the formats registry sorts one shared
    entry-point group into two ports.

    **It reports and it does not record.** Moving a connection to ``ready``,
    storing the family that was observed, and counting what arrived all stay above
    this line. That is ``Exporter``'s rule — ``ReleaseService.export`` counts what
    a plugin wrote precisely because a number reported by the thing it describes
    is not checkable — and it is what keeps a driver from being able to claim a
    download succeeded.
    """

    def price(self, model_id: str, model_revision: str) -> DownloadSize:
        """What fetching that exact snapshot would cost, before anybody fetches it.

        Keyed on the pair rather than on a connection because the moment it is
        needed is the moment before a connection exists — a form is being filled
        in.

        **Downloads nothing.** A size somebody has to pay for to discover is not
        an answer to the question being asked.

        Raises:
            VisionSetError: the size cannot be established. A refusal rather than
                a zero: a form showing "0 B" would be inviting somebody to confirm
                a download it knows nothing about.
        """
        ...

    def family_of(self, connection: InferenceConnection, *, cache_dir: Path) -> str:
        """The family the downloaded snapshot declares, or ``""`` if it cannot say.

        Read from what is already on disk and never from a network, because this
        product fetches when somebody asks it to and at no other time.

        ``""`` rather than a raise when the files cannot be read: reading them and
        deciding what to do about them are separate jobs, and this one only
        reports. It is not a family, so resolution refuses it — the same answer it
        gives a family nothing serves, because "the config said nothing" and "the
        config said something unknown" leave a resolver equally unable to pick a
        driver honestly.
        """
        ...

    def fetch(
        self,
        connection: InferenceConnection,
        *,
        into: Path,
        on_bytes: Callable[[int], None] | None = None,
    ) -> Path:
        """Put this connection's weights in that cache, and say where they landed.

        ``on_bytes`` is a plain callable rather than a ``ProgressReporter``,
        because the kernel hands its plugins domain values and never a port — and
        because a driver reporting progress should not have to know how the caller
        is organised. It is optional: a source with nothing to stream omits it,
        and a caller that does not care passes nothing.

        The revision the connection pinned is fetched as given and **never**
        defaulted to a branch when the pin does not resolve. Quietly fetching a
        moving pointer produces weights whose identity the row now misdescribes,
        which is the provenance failure the pin exists to prevent.

        Raises:
            VisionSetError: the weights could not be fetched — a revision that
                does not resolve, a repository requiring access that has not been
                granted, a transfer that failed.
        """
        ...
