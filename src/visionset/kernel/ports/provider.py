# usage: from visionset.kernel.ports import Provider, WeightsSource
"""What a driver declares about itself, and what it builds when a connection asks.

``ModelProvider`` and ``PointSegmenter`` describe asking a model something. This
describes the object a distribution registers, discovered through the
``visionset.providers`` entry-point group as ``Exporter`` is through
``visionset.formats``.

**Closed capabilities, open providers.** :data:`Provider.families` maps a family
onto a member of ``ModelCapability``, the kernel's own closed vocabulary, so a
driver may serve a capability and can never introduce one.

**Installing a driver must not let a workspace predict**, and does not: nothing is
fetched or loaded, and a driver becomes reachable rather than a model becoming
present. The connection stays the registry; discovery only supplies the table
resolution consults.

**This port may name a ``Path`` where the model ports may not.** That ban exists
because a filesystem type in a signature claims a disk shared with whatever
answers across a network. Nothing here crosses one — a provider is described and
asked to build in this process — so this is ``Exporter``'s shape, and
``tests/architecture/test_provider_port.py`` sweeps it instead.
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

A union rather than one widened port: a detector is asked what it sees and answers
in boxes, a segmenter is asked what is under a point and answers in pixels. Only
the return type has to admit both; the caller narrows with ``isinstance``.
"""


@runtime_checkable
class Provider(Protocol):
    """A driver: what it serves, what it offers by name, and what it builds.

    **Constructed with no arguments**, on ``Exporter``'s terms — discovery does
    ``entry_point.load()()`` and reads the declarations below. So everything a
    provider says about itself must be answerable before any connection exists and
    without the optional runtime installed.

    ``@runtime_checkable`` so discovery can check an *instance*; ``issubclass``
    against a protocol with data members raises.
    """

    #: What this driver calls itself. Distinct from its entry-point name, which is
    #: packaging metadata: two strings, and only this one is the contract.
    provider_id: str

    #: Which families this driver serves, and what each can be asked for.
    #:
    #: A mapping rather than a set, which is the derivation guarantee: declaring
    #: the family and its capability separately is how a family acquires an
    #: adapter and never acquires a declaration, leaving a model that runs while
    #: invisible to every client filtering on what a connection can be asked.
    families: Mapping[str, ModelCapability]

    #: Checkpoints offered by name. Empty is legitimate — a driver that runs
    #: whatever it is pointed at curates nothing. Each entry's ``family`` must be
    #: one of :data:`families`.
    curated: tuple[CuratedModel, ...]

    def build(
        self, connection: InferenceConnection, *, family: str, workspace_root: Path
    ) -> Runner:
        """The thing that will answer for this connection.

        ``family`` is which of :data:`families` this connection resolved to. A
        driver serving several is told which rather than working it out: the
        family is declared by the snapshot on disk, a connection does not always
        carry it, and more than one architecture can answer the same prompt kind
        while loading through different classes.

        **Loads nothing** — weights load lazily inside what this returns, so a
        caller may build one to find out whether a connection *could* run.

        What comes back satisfies the port the declared capability implies:
        ``point_suggest`` builds a ``PointSegmenter``, ``text_detect`` a
        ``ModelProvider``. The conformance suite holds a driver to that.

        Raises:
            VisionSetError: this connection cannot be run. It must raise from that
                tree rather than let an implementation library's exception out, so
                every surface renders a sentence instead of a stack trace.
        """
        ...


@runtime_checkable
class WeightsSource(Protocol):
    """Where a driver's weights come from, for a driver whose weights are local.

    A second protocol rather than three more members on the first: a hosted driver
    has nothing to fetch, price, or read a family from, and three methods whose
    only implementation is a refusal is the shape this repository has already paid
    for twice. Callers ask with ``isinstance``.

    **It reports and does not record.** Moving a connection to ``ready``, storing
    the observed family, and counting what arrived stay above this line — a number
    reported by the thing it describes is not checkable.
    """

    def price(self, model_id: str, model_revision: str) -> DownloadSize:
        """What fetching that snapshot would cost, before anybody fetches it.

        Keyed on the pair because the moment it is needed is the moment before a
        connection exists. **Downloads nothing.**

        Raises:
            VisionSetError: the size cannot be established. A refusal rather than
                a zero, which would invite confirming a download nothing is known
                about.
        """
        ...

    def family_of(self, connection: InferenceConnection, *, cache_dir: Path) -> str:
        """The family the downloaded snapshot declares, or ``""`` if it cannot say.

        Read from disk, never from a network: this product fetches when somebody
        asks it to and at no other time. ``""`` rather than a raise — reading the
        files and deciding what to do about them are separate jobs.
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

        ``on_bytes`` is a plain callable rather than a ``ProgressReporter``: the
        kernel hands its plugins domain values and never a port.

        The pinned revision is fetched as given and never defaulted to a branch —
        that would produce weights whose identity the row now misdescribes.

        Raises:
            VisionSetError: the weights could not be fetched.
        """
        ...
