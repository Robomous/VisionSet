# usage: from visionset.inference import fetch_weights, MODELS_DIRNAME
"""Fetching the weights a local connection names, into the workspace.

**VisionSet never downloads a model on its own** — the decision recorded on #418,
and this module is the only place in the distribution that downloads one at all.
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

**Idempotent, and it is the handler's idempotency that needs it.** A connection
already ``ready`` is verified — the files are looked for — and left alone. That
is not a convenience for people typing twice: the download job is registered
idempotent, and an orphan re-queued after a crash arrives at a connection a
previous attempt already finished.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Final
from uuid import UUID

from visionset.inference._extra import imported
from visionset.kernel.domain import ConnectionType, InferenceConnection
from visionset.kernel.errors import LocalInferenceUnavailable
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

_logger: Final = logging.getLogger(__name__)

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
    retrying: bool = False,
    on_progress: Callable[[str], None] | None = None,
) -> InferenceConnection:
    """Fetch the weights this connection names, then mark it ready.

    The whole operation, in the order that makes the failure safe, and the one
    body three surfaces share: the background job runs it, the CLI runs it
    inline, and a future UI reaches it through the job. Two implementations of
    this sequence is how the CLI and the API would come to disagree about what
    "set up" means.

    ``retrying`` is passed by the job handler and by nobody else, and it is what
    makes a re-run safe rather than merely cheap: an orphan re-enqueued after a
    crash may arrive at a connection a previous attempt already finished, and
    ``require_downloadable`` explains why refusing that would be wrong. The work
    it then does is a *verification* — the snapshot download checks a cache it
    already filled against its hashes rather than re-fetching it — and the write
    below is a no-op on a connection that is already ready.

    ``on_progress`` is a plain callable rather than a ``ProgressReporter``,
    because what this can honestly report is a *phase* and not a count: a
    snapshot download reports bytes through its own library's bar, and inventing
    an item count over files nobody asked about would be a number that looks like
    progress. The job handler turns each phase into a reporter call; the CLI
    prints it.

    Raises:
        InferenceConnectionNotFound: no such connection in this workspace.
        InferenceConnectionNotDownloadable: it is already set up, or it is a kind
            with no weights of its own.
        LocalInferenceUnavailable: the optional runtime is not installed.
    """
    connections = InferenceConnectionService(workspace)
    connection = connections.require_downloadable(connection_id, retrying=retrying)
    say = on_progress or (lambda _: None)

    say(f"fetching {connection.model_id} at {connection.model_revision}")
    download(connection, into=cache_root(workspace.root))
    say("recording the connection as ready")
    return connections.record_weights_ready(connection.id)


def download(connection: InferenceConnection, *, into: Path) -> Path:
    """Put this connection's weights in that cache, and say where they landed.

    Original sources, per the neutral-foundations decision on #418: the model id
    and the revision the connection pinned, resolved by ``huggingface_hub``
    against the hub the weights are published on. No mirror, no rewriting of
    what somebody typed.

    The revision is passed through as given and is **not** defaulted to a branch
    name. A connection carries a pinned revision because it is required to, and
    quietly fetching ``main`` when a pin does not resolve would produce weights
    whose identity the row now misdescribes — which is the provenance failure the
    pin exists to prevent.

    Idempotent by the library's own design: a snapshot already in the cache is
    verified against its hashes and not re-fetched, which is what makes a
    re-run of the job cheap rather than merely safe.

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
