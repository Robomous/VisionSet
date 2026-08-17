"""Which inference drivers this deployment has, and what each offers by name.

The un-overridden test is deliberate, on `test_formats.py`'s terms: it is the one
place in the server suite that asserts the real ``visionset.providers`` group
reaches a route. Everything after it substitutes drivers through the dependency,
because a listing tested only against what this repository ships proves nothing
about a listing whose whole point is what somebody else installed.

The fakes are plain classes in this module rather than a shared `_providers.py`:
one module needs them, and a shared double invites a second caller to inherit
declarations it did not choose.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client

from visionset.kernel.domain import CuratedModel, InferenceConnection, ModelCapability
from visionset.kernel.ports import Provider, Runner
from visionset.server.dependencies import get_providers


class FakeProvider:
    """A driver with whatever declarations a case needs.

    Structural rather than a subclass: ``Provider`` is a protocol, and a fake that
    inherited from something would be proving the inheritance rather than the
    shape discovery actually checks.
    """

    def __init__(
        self,
        provider_id: str,
        families: Mapping[str, ModelCapability],
        curated: tuple[CuratedModel, ...] = (),
    ) -> None:
        self.provider_id = provider_id
        self.families = dict(families)
        self.curated = curated

    def build(
        self, connection: InferenceConnection, *, family: str, workspace_root: Path
    ) -> Runner:
        raise AssertionError("the listing never builds a runner")


def entry(
    model_id: str,
    family: str,
    *,
    hint: str = "a line about this one",
    access_note: str | None = None,
    access_url: str | None = None,
) -> CuratedModel:
    return CuratedModel(
        model_id=model_id,
        # A real 40-character commit: the domain model refuses a branch, and an
        # entry that could not exist would make every assertion below vacuous.
        model_revision="0" * 40,
        family=family,
        hint=hint,
        access_note=access_note,
        access_url=access_url,
    )


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


def with_providers(client: TestClient, *providers: Provider) -> None:
    """Answer the route from these drivers instead of the installed ones."""
    client.app.dependency_overrides[get_providers] = lambda: {
        provider.provider_id: provider for provider in providers
    }


def test_the_installed_drivers_are_listed_without_any_override(client: TestClient) -> None:
    """The real scan, through the real dependency, over the real entry-point group."""
    body = client.get("/inference/providers").json()

    assert body["total"] >= 1
    assert "sam" in {row["provider_id"] for row in body["items"]}


def test_a_driver_publishes_which_families_it_serves(client: TestClient) -> None:
    with_providers(
        client,
        FakeProvider("acme", {"acme_seg": ModelCapability.POINT_SUGGEST}),
    )

    rows = client.get("/inference/providers").json()["items"]

    assert rows[0]["families"] == {"acme_seg": "point_suggest"}


def test_a_curated_entry_carries_the_capability_its_family_resolves_to(
    client: TestClient,
) -> None:
    """The entry names a family; the form groups by ability. Resolving it here is
    what keeps a client from re-deriving a mapping the driver already stated."""
    with_providers(
        client,
        FakeProvider(
            "acme",
            {"acme_seg": ModelCapability.POINT_SUGGEST},
            (entry("acme/seg-small", "acme_seg"),),
        ),
    )

    [row] = client.get("/inference/providers").json()["items"]

    assert row["curated"][0]["capability"] == "point_suggest"


def test_an_entry_naming_a_family_its_own_driver_does_not_serve_is_left_out(
    client: TestClient,
) -> None:
    """One malformed entry does not cost the reader the listing.

    Nothing in this repository writes such an entry — the conformance suite
    refuses it at the source — but this route reads declarations written
    elsewhere, and there is no capability to publish for a family the declaring
    driver does not serve.
    """
    with_providers(
        client,
        FakeProvider(
            "acme",
            {"acme_seg": ModelCapability.POINT_SUGGEST},
            (entry("acme/seg-small", "acme_seg"), entry("acme/ghost", "not_declared")),
        ),
    )

    [row] = client.get("/inference/providers").json()["items"]

    assert [one["model_id"] for one in row["curated"]] == ["acme/seg-small"]


def test_curated_entries_keep_the_order_their_driver_declared_them_in(
    client: TestClient,
) -> None:
    """A ladder's rungs are information. Sorting them would be a second opinion
    about which checkpoint a person should read first."""
    with_providers(
        client,
        FakeProvider(
            "acme",
            {"acme_seg": ModelCapability.POINT_SUGGEST},
            (
                entry("acme/seg-tiny", "acme_seg"),
                entry("acme/seg-large", "acme_seg"),
                entry("acme/seg-base", "acme_seg"),
            ),
        ),
    )

    [row] = client.get("/inference/providers").json()["items"]

    assert [one["model_id"] for one in row["curated"]] == [
        "acme/seg-tiny",
        "acme/seg-large",
        "acme/seg-base",
    ]


def test_drivers_come_back_in_provider_id_order(client: TestClient) -> None:
    """A listing whose order depended on entry-point scan order would not be stable."""
    with_providers(
        client,
        FakeProvider("zeta", {"zeta_det": ModelCapability.TEXT_DETECT}),
        FakeProvider("acme", {"acme_seg": ModelCapability.POINT_SUGGEST}),
    )

    ids = [row["provider_id"] for row in client.get("/inference/providers").json()["items"]]

    assert ids == sorted(ids)


def test_a_build_with_no_drivers_answers_an_empty_page(client: TestClient) -> None:
    """An empty installation is an answer rather than a failure: nothing is
    misconfigured about a workspace whose models are all typed in by hand."""
    with_providers(client)

    assert client.get("/inference/providers").json() == {"items": [], "total": 0}


def test_the_listing_uses_the_envelope_like_every_other_collection(
    client: TestClient,
) -> None:
    with_providers(
        client,
        FakeProvider(
            "acme",
            {"acme_seg": ModelCapability.POINT_SUGGEST},
            (
                entry(
                    "acme/seg-gated",
                    "acme_seg",
                    hint="wants a GPU",
                    access_note="Acme grants access by request.",
                    access_url="https://example.invalid/acme/seg-gated",
                ),
            ),
        ),
    )

    assert client.get("/inference/providers").json() == {
        "items": [
            {
                "provider_id": "acme",
                "families": {"acme_seg": "point_suggest"},
                "curated": [
                    {
                        "model_id": "acme/seg-gated",
                        "model_revision": "0" * 40,
                        "family": "acme_seg",
                        "capability": "point_suggest",
                        "hint": "wants a GPU",
                        "access_note": "Acme grants access by request.",
                        "access_url": "https://example.invalid/acme/seg-gated",
                    }
                ],
            }
        ],
        "total": 1,
    }
