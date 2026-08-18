# usage: from visionset.server.routes import providers
"""Which models this deployment can run, and which it offers by name.

One route, and a listing rather than a line in the documentation, for the reason
``formats.py`` gives: the answer is a property of the *installation*. Any
distribution registering into the ``visionset.providers`` entry-point group adds
a row here, and nothing in this repository can enumerate what somebody else has
installed.

Not nested under anything. A driver is not owned by a project, a dataset or a
connection — the same set is available to all of them — and hanging the list off
one of those would suggest otherwise.

**Installing a driver does not make a model present.** Every row here says a
family is reachable: there is still no connection, still no weights on disk, and
still nothing that will answer a request.

Handlers are ``def``, not ``async def``, for the reason ``projects.py`` gives.
"""

from __future__ import annotations

from visionset.server.dependencies import ProvidersDep, protected_router
from visionset.server.models import ProviderOut, ProviderPage

router = protected_router(prefix="/inference/providers", tags=["inference"])


@router.get("")
def list_providers(providers: ProvidersDep) -> ProviderPage:
    """Every inference driver installed on this server, and what each offers.

    `families` maps a model type — the `model_type` a checkpoint's own config
    declares — onto what a model of that type can be asked for. It is the same
    vocabulary `capabilities` uses on a connection, and it answers a different
    question: this says what *could* run here, that says what one configured
    connection's weights turned out to be.

    `curated` is the checkpoints a driver offers by name, in the order it
    declared them, and each entry's `capability` is a member of that same
    vocabulary — the one its family resolves to, through the driver that
    declared both. Filter on it rather than switching on it: the vocabulary is
    open, so an entry may name an ability this client was never compiled
    against. Curation guides and never restricts: any model id remains typeable
    at any revision, and an empty list is an ordinary answer from a driver that
    runs whatever it is pointed at.

    A curated entry carries **no size**. What a download costs is
    `GET /inference/download-size`, read live for the exact pair, because a
    number frozen into a catalog would be a second answer to a question already
    answered accurately.

    Empty when nothing is installed, which is an answer rather than a failure.
    """
    installed = providers.values()
    return ProviderPage(
        items=sorted(
            (ProviderOut.of(provider) for provider in installed),
            key=lambda out: out.provider_id,
        ),
        total=len(installed),
    )
