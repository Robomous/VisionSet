# usage: from visionset.inference import fetch_weights, MODELS_DIRNAME
"""Fetching the weights a local connection names, into the workspace.

**VisionSet never downloads a model on its own**, and this module is the only
place in the distribution that downloads one at all.
It runs when somebody asks: a route, a command, or a background job started by
one of those. Nothing calls it at install time, at startup, or on the way to
anything else.

**The cache lives under the workspace.** A workspace is the unit somebody copies,
backs up, and hands to a colleague, and a workspace whose model arrives with it
is one that opens and works. The alternative — a shared cache in a home
directory — makes "does this workspace run?" a question about the machine, which
is the local-first promise inverted. It is a sibling of ``exports/`` and
``uploads/`` and server-owned in the same way: the kernel writes neither, and
``WorkspaceService.open`` tolerates both because it only ever refuses a
*non-empty* directory at ``init``.

**The state flip is the last statement.** :func:`fetch_weights` downloads, and
only then records the connection ready. A run that fails partway has changed
nothing, so there is no half-``ready`` row for a reader to find and no third
state meaning "some of it arrived". That is an ordering rather than a guard,
which is why nothing in the domain has to encode it.

**What arrives is also read, once.** A download ends by reading the model's own
config out of the cache it just filled and recording the family it declares, so
that a client can be told what this connection may be asked for. That is the
first moment the answer exists without a network call, which is why it happens
here rather than at connection creation — and :func:`with_families` is the same
read, late, for rows written before the column existed.

**Idempotent, and two callers need it to be.** A connection already ``ready`` is
re-checked — every file the revision names is looked for, and anything missing is
fetched — and then left alone. That is not only a convenience for people typing
twice: the download job is registered idempotent, an orphan re-queued after a
crash arrives at a connection a previous attempt already finished, and so does
somebody asking a set-up connection to check itself.

**What that check is, precisely.** ``huggingface_hub`` addresses its cache by the
revision's commit hash and each file's etag, so a re-run at a pinned revision
finds the files it already has and returns them without reading their bytes.
What a re-run therefore proves is that the snapshot is **complete** — the common
failure, since a download interrupted by a network or a full disk leaves it
incomplete — and what it does not prove is that a file already on disk still
holds the bytes it was written with. Saying the difference out loud is the point:
a control labelled as a check must not imply an integrity guarantee the library
underneath it does not make.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Final
from uuid import UUID

from visionset.inference._extra import imported
from visionset.inference.cache import BoundedCache
from visionset.inference.families import family_of
from visionset.kernel.domain import (
    ConnectionSetupState,
    ConnectionType,
    DownloadSize,
    InferenceConnection,
)
from visionset.kernel.errors import LocalInferenceUnavailable
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

_logger: Final = logging.getLogger(__name__)

DEFAULT_SIZE_CAPACITY: Final = 32
"""How many ``model_id@revision`` sizes to remember.

Small because the working set is: the models offered in a form, plus whatever
somebody typed while deciding. Each entry is two integers and two short strings,
so the bound is about not growing without limit rather than about memory.
"""

MODELS_DIRNAME: Final = "models"
"""Where weights land, under the workspace root.

One directory for the whole workspace rather than one per connection, because
the cache is content-addressed by the library that fills it: two connections
pinned to the same model and revision share the files instead of holding two
copies of six gigabytes.
"""


def cache_root(workspace_root: Path) -> Path:
    """This workspace's model cache. Not created here — the download creates it."""
    return workspace_root / MODELS_DIRNAME


def fetch_weights(
    workspace: WorkspaceService,
    connection_id: UUID,
    *,
    on_progress: Callable[[str], None] | None = None,
) -> InferenceConnection:
    """Fetch the weights this connection names, then mark it ready.

    The whole operation, in the order that makes the failure safe, and the one
    body three surfaces share: the background job runs it, the CLI runs it
    inline, and a future UI reaches it through the job. Two implementations of
    this sequence is how the CLI and the API would come to disagree about what
    "set up" means.

    **A run against a connection that is already ``ready`` is a re-check, and it
    needs no flag to be one.** The snapshot download finds what the cache
    already holds and fetches only what is missing, and the write below is a
    no-op on a connection that is already ready — so the orphan the queue
    re-enqueues after a crash and the person asking a set-up connection to check
    itself take the identical path. What it establishes is completeness rather
    than integrity; see this module's docstring for why the distinction is worth
    a paragraph.

    ``on_progress`` is a plain callable rather than a ``ProgressReporter``,
    because what this can honestly report is a *phase* and not a count: a
    snapshot download reports bytes through its own library's bar, and inventing
    an item count over files nobody asked about would be a number that looks like
    progress. The job handler turns each phase into a reporter call; the CLI
    prints it.

    Raises:
        InferenceConnectionNotFound: no such connection in this workspace.
        InferenceConnectionNotDownloadable: it is a kind with no weights of its
            own.
        LocalInferenceUnavailable: the optional runtime is not installed.
    """
    connections = InferenceConnectionService(workspace)
    connection = connections.require_downloadable(connection_id)
    say = on_progress or (lambda _: None)
    cache = cache_root(workspace.root)

    say(f"fetching {connection.model_id} at {connection.model_revision}")
    download(connection, into=cache)
    # Only knowable now, and knowable without a network only now: the config
    # that says what kind of model this is arrived with the weights. Reading it
    # here is what lets a client be told what this connection can be asked for
    # instead of finding out one refusal at a time — see ``families``.
    say("reading what kind of model arrived")
    family = _family_if_it_can_be_read(connection, cache_dir=cache)
    say("recording the connection as ready")
    return connections.record_weights_ready(connection.id, model_family=family)


def _family_if_it_can_be_read(connection: InferenceConnection, *, cache_dir: Path) -> str | None:
    """What the config declares, or ``None`` where nothing here could read it.

    **A download that worked must not be undone by a question about it.** The
    bytes are on the disk by the time this is asked; letting the read's refusal
    out would leave the connection ``not_set_up`` beside a full cache, and the
    remedy on offer would be the transfer that already happened. So a build that
    cannot read a config records that it does not know, which is recoverable —
    the next read of the connection asks again (:func:`with_families`).

    Only :class:`LocalInferenceUnavailable` is caught, and only that. Anything
    the read itself could not survive is already ``""`` by ``family_of``'s own
    contract, so what is left here is exactly one condition: nothing on this
    machine can parse a config at all.
    """
    try:
        return family_of(connection, cache_dir=cache_dir)
    except LocalInferenceUnavailable:
        _logger.info("no runtime here to read %s's config", connection.name)
        return None


def with_families(
    workspace: WorkspaceService, connections: Sequence[InferenceConnection]
) -> list[InferenceConnection]:
    """Those connections, with any missing family filled in from the cache.

    The backfill for every row written before a connection recorded what kind of
    model it points at. It is deliberately *not* a migration: the answer lives in
    a model config inside this workspace's cache, the kernel is forbidden from
    reaching that cache, and a migration runs inside the kernel — so the only
    place this can happen is out here, where the resolver already lives.

    **A read that writes, and the bound is what makes it honest.** It touches
    only a ``local`` connection that is ``ready`` and has never been asked, it
    reads a small JSON file already on this disk, and it reaches no network. Once
    a row has an answer — *any* answer, the empty string included — it is never
    considered again, so the whole cost is one config read per pre-existing row,
    once, ever. A row created after this shipped arrives with its family already
    recorded by the download and never enters the loop at all.

    **What it will not do is invent one.** A build without the optional runtime
    cannot read a config, and a build that cannot look has not looked: the
    connection is returned exactly as it was, still NULL, so a machine that later
    installs the runtime resolves it then. Writing the empty string there would
    record "this model declares nothing" on the strength of never having
    checked — and every client filtering on the declaration would believe it.
    That is :func:`_family_if_it_can_be_read`'s rule, shared with the download so
    there is one answer to "what does a build that cannot look record".
    """
    service = InferenceConnectionService(workspace)
    cache = cache_root(workspace.root)
    resolved: list[InferenceConnection] = []
    for connection in connections:
        if not _awaiting_a_family(connection):
            resolved.append(connection)
            continue
        family = _family_if_it_can_be_read(connection, cache_dir=cache)
        if family is None:
            resolved.append(connection)
            continue
        _logger.info("resolved %s as model type %r", connection.name, family)
        # The same write the download makes, made late — one encoding of "the
        # weights are here and this is what they turned out to be", rather than a
        # second path that could disagree with it. The state half is already
        # true, so what this commits is the family.
        resolved.append(service.record_weights_ready(connection.id, model_family=family))
    return resolved


def _awaiting_a_family(connection: InferenceConnection) -> bool:
    """Whether reading this connection's config is a question worth asking.

    Three conditions, each ruling out a different kind of nonsense: an ``http``
    connection keeps its model somewhere else, so there is no config here to
    read and the vocabulary for what a remote endpoint declares does not exist
    yet; a connection that is not ``ready`` has no files at all; and one that
    already carries an answer has been asked.
    """
    return (
        connection.connection_type is ConnectionType.LOCAL
        and connection.setup_state is ConnectionSetupState.READY
        and connection.model_family is None
    )


def download(connection: InferenceConnection, *, into: Path) -> Path:
    """Put this connection's weights in that cache, and say where they landed.

    Original sources: the model id and the revision the connection pinned,
    resolved by ``huggingface_hub``
    against the hub the weights are published on. No mirror, no rewriting of
    what somebody typed.

    The revision is passed through as given and is **not** defaulted to a branch
    name. A connection carries a pinned revision because it is required to, and
    quietly fetching ``main`` when a pin does not resolve would produce weights
    whose identity the row now misdescribes — which is the provenance failure the
    pin exists to prevent.

    Idempotent by the library's own design, and idempotent in a specific way. A
    file already in the cache under this revision's commit hash is returned
    without being re-read, so a re-run costs a metadata call per file and fetches
    only what is absent; a file that arrives is checked against the size the hub
    published for it before it is moved into place, and a transfer interrupted
    part-way resumes from what it had. So a re-run repairs a snapshot that is
    incomplete and cannot detect one that is complete but damaged.

    Raises:
        LocalInferenceUnavailable: ``huggingface_hub`` is not installed, or the
            download failed for a reason a caller can act on.
    """
    if connection.connection_type is not ConnectionType.LOCAL:
        # Not reachable through ``fetch_weights`` — ``require_downloadable``
        # refuses first — and kept because this is a public function and a
        # caller reaching it directly deserves the sentence rather than a
        # confusing download of nothing.
        raise LocalInferenceUnavailable(
            f"connection {connection.name!r} runs its model elsewhere; there is nothing to fetch"
        )
    hub = imported("huggingface_hub")
    into.mkdir(parents=True, exist_ok=True)
    _logger.info("fetching %s at %s into %s", connection.model_id, connection.model_revision, into)
    try:
        return Path(
            hub.snapshot_download(
                repo_id=connection.model_id,
                revision=connection.model_revision,
                cache_dir=str(into),
            )
        )
    except Exception as exc:  # noqa: BLE001 — see below
        # Every way a download can fail is one exception tree away from another
        # — a repository that is not there, a revision that does not resolve, a
        # network that went, a disk that filled — and ``huggingface_hub`` spells
        # each in its own class. Catching the base and re-raising in the
        # kernel's vocabulary is the same translation ``_built`` does for
        # pydantic, and it is what keeps a failed job carrying a sentence
        # instead of a library traceback nobody can act on.
        raise LocalInferenceUnavailable(
            f"could not fetch {connection.model_id} at {connection.model_revision}: {exc}"
        ) from exc


def measure(model_id: str, model_revision: str) -> DownloadSize:
    """How big that revision is, asked of the hub's metadata and nothing else.

    **Nothing is downloaded here, and that is the whole point of the function.**
    ``model_info`` reads the repository's file listing — names and byte counts —
    which is the one question that can be answered before somebody has agreed to
    pay for the answer. Reaching :func:`download` to find out how big a download
    would be is the shape this exists to avoid, and
    ``test_measuring_a_size_downloads_nothing`` is what holds it.

    Every file in the revision is counted, because :func:`download` fetches every
    file in the revision. The two numbers describe the same set on purpose: a
    figure that counted only the weights would understate what lands on the disk
    for any repository that also publishes a tokenizer, a processor config, or a
    second serialisation of the same tensors.

    A file the listing does not size is refused rather than skipped. Silently
    dropping it would answer with a number smaller than the truth, which is worse
    than no number at all when the number's whole job is to inform a decision.

    Raises:
        LocalInferenceUnavailable: ``huggingface_hub`` is not installed, the
            revision could not be read, or the listing did not size every file.
    """
    hub = imported("huggingface_hub")
    _logger.debug("reading the size of %s at %s", model_id, model_revision)
    try:
        info = hub.model_info(model_id, revision=model_revision, files_metadata=True)
    except Exception as exc:  # noqa: BLE001 — ``download``'s reason, one call earlier
        raise LocalInferenceUnavailable(
            f"could not read the size of {model_id} at {model_revision}: {exc}"
        ) from exc
    files = tuple(getattr(info, "siblings", None) or ())
    if not files:
        raise LocalInferenceUnavailable(
            f"the hub listed no files for {model_id} at {model_revision}, so there is no "
            "size to show; check the model id and the revision"
        )
    total = 0
    unsized: list[str] = []
    for one in files:
        size = getattr(one, "size", None)
        if size is None:
            unsized.append(str(getattr(one, "rfilename", "?")))
            continue
        total += int(size)
    if unsized:
        raise LocalInferenceUnavailable(
            f"the hub did not report a size for {len(unsized)} of {len(files)} files in "
            f"{model_id} at {model_revision} (for example {unsized[0]!r}), so the download "
            "size cannot be stated"
        )
    return DownloadSize(
        model_id=model_id,
        model_revision=model_revision,
        total_bytes=total,
        file_count=len(files),
    )


class DownloadSizes:
    """Sizes already looked up, bounded and least-recently-used.

    Instantiable rather than only module-level for ``ProviderPool``'s reason: a
    test holds its own and asserts on it without reaching into process state.

    **A size is immutable per revision**, which is what makes caching it correct
    rather than merely fast: a pinned revision is a fixed set of files, so the
    answer cannot go stale. That is also why nothing invalidates this — there is
    no event that could change what it holds. A moving pointer like ``main`` is
    the one case where the pin is not a pin, and it is cached anyway: a
    connection is required to carry a real revision (`domain/inference.py`), so
    the only caller that can reach one is a form somebody is still typing into.
    """

    def __init__(self, capacity: int = DEFAULT_SIZE_CAPACITY) -> None:
        self._held: BoundedCache[str, DownloadSize] = BoundedCache(capacity)
        self._lookups = 0

    @property
    def lookups(self) -> int:
        """How many times this has actually reached the hub.

        The counter that separates a working cache from one that asks every time
        — both answer correctly, and only this tells them apart.
        """
        return self._lookups

    def get(self, model_id: str, model_revision: str) -> DownloadSize:
        """That revision's size, read once and kept."""
        key = f"{model_id}@{model_revision}"
        held = self._held.get(key)
        if held is not None:
            return held
        measured = measure(model_id, model_revision)
        self._lookups += 1
        return self._held.put(key, measured)

    def clear(self) -> None:
        """Forget everything. What a test does between cases."""
        self._held.clear()

    def __len__(self) -> int:
        return len(self._held)


_KNOWN: Final = DownloadSizes()


def known_sizes() -> DownloadSizes:
    """The process-wide size cache, on ``resident``'s terms."""
    return _KNOWN


def download_size(model_id: str, model_revision: str) -> DownloadSize:
    """What fetching that revision would cost, from the cache or from the hub.

    The one surfaces call: a route before a form confirms, and the CLI when
    somebody wants the number before typing ``download``.
    """
    return known_sizes().get(model_id, model_revision)
