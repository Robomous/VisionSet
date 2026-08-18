"""``visionset release`` — publishing, and the command whose exit code is the answer."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from tests.cli._flow import (
    ok,
    payload,
    promoted_project,
    published_release,
    run,
    schemad_project,
    workspace,
)

from visionset.kernel.domain import Annotation, Asset, BboxGeometry, GeometryType, LabelClass
from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    AnnotationService,
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
    ReleaseService,
    SchemaService,
    WorkspaceService,
)


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return workspace(tmp_path)


def _manifest_blob(root: Path, name: str, tag: str) -> Path:
    with WorkspaceService.open(root) as service:
        project = ProjectService(service).get_by_name(name)
        dataset = ProjectService(service).get_dataset(project.id)
        release = ReleaseService(service).get_by_tag(dataset.id, tag)
        digest = release.manifest_hash
    # The blob store's own sharding, ``<root>/<hash[:2]>/<hash[2:4]>/<hash>``.
    return root / "blobs" / digest[:2] / digest[2:4] / digest


def _schema_incompatible_project(root: Path) -> str:
    with WorkspaceService.open(root) as service:
        projects = ProjectService(service)
        schemas = SchemaService(service)
        batches = BatchService(service)
        jobs = JobService(service)
        annotations = AnnotationService(service)
        datasets = DatasetService(service)
        project = projects.create("schema-incompatible")
        sign = LabelClass(name="sign", geometries=(GeometryType.BBOX,))
        car = LabelClass(name="car", geometries=(GeometryType.BBOX,))
        schemas.create_version(project.id, [sign, car])
        content_hash = service.blob_store.put(BytesIO(b"schema-incompatible"))
        with service.unit_of_work() as uow:
            asset = uow.assets.add(
                Asset(
                    project_id=project.id,
                    content_hash=content_hash,
                    uri="/tmp/schema-incompatible.png",
                    width=640,
                    height=480,
                )
            )
        batch = batches.create(project.id, "v1 work", [asset.id])
        batches.approve(batch.id)
        (job,) = batches.jobs(batch.id)
        batches.start(batch.id)
        jobs.start(job.id)
        schemas.create_version(project.id, [sign], allow_destructive=True)
        annotations.add(
            job.id,
            [
                Annotation(
                    asset_id=asset.id,
                    label_class="car",
                    schema_version=1,
                    geometry=BboxGeometry(x=1, y=2, width=30, height=40),
                    provenance="human",
                )
            ],
        )
        jobs.complete(job.id)
        batches.complete(batch.id)
        datasets.promote(batch.id)
    return project.name


# --- publish -----------------------------------------------------------------


def test_publish_freezes_the_trunk(root: Path, tmp_path: Path) -> None:
    name = promoted_project(root, tmp_path)
    document = payload(root, "release", "publish", "--tag", "v1.0", "-p", name)
    assert document["tag"] == "v1.0"
    assert document["asset_count"] == 6
    assert document["schema_version"] == 1


def test_a_release_of_a_cli_driven_batch_carries_no_annotations(root: Path, tmp_path: Path) -> None:
    # Said out loud rather than hidden: ``job mark --progress annotated`` records
    # that somebody labeled an asset, and the CLI writes no labels. The manifest
    # is honest about it.
    name = promoted_project(root, tmp_path)
    assert payload(root, "release", "publish", "--tag", "v1.0", "-p", name)["annotation_count"] == 0


def test_publishing_an_empty_trunk_exits_one(root: Path, tmp_path: Path) -> None:
    name = schemad_project(root, tmp_path)
    result = run(root, "release", "publish", "--tag", "v1.0", "-p", name)
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


def test_publishing_content_outside_the_active_schema_exits_one_with_a_remedy(root: Path) -> None:
    name = _schema_incompatible_project(root)

    result = run(root, "release", "publish", "--tag", "v1.0", "-p", name)

    assert result.exit_code == 1, result.output
    assert "Reconcile the annotations or restore a compatible active schema." in result.stderr


def test_a_repeated_tag_exits_one(root: Path, tmp_path: Path) -> None:
    # A release is never edited, so the remedy named in the refusal is a new tag.
    name = published_release(root, tmp_path)
    assert run(root, "release", "publish", "--tag", "v1.0", "-p", name).exit_code == 1


def test_a_tag_is_case_sensitive(root: Path, tmp_path: Path) -> None:
    # The opposite rule to a project name, which is why both live in the kernel.
    name = published_release(root, tmp_path)
    assert run(root, "release", "publish", "--tag", "V1.0", "-p", name).exit_code == 0


# --- the split ---------------------------------------------------------------


def test_split_is_stored_on_the_release(root: Path, tmp_path: Path) -> None:
    name = promoted_project(root, tmp_path)
    document = payload(
        root, "release", "publish", "--tag", "v1.0", "-p", name, "--split", "0.5,0.25,0.25"
    )
    assert document["split"] == {"train": 0.5, "val": 0.25, "test": 0.25, "seed": 0}


def test_seed_reaches_the_recipe(root: Path, tmp_path: Path) -> None:
    name = promoted_project(root, tmp_path)
    document = payload(
        root,
        "release",
        "publish",
        "--tag",
        "v1.0",
        "-p",
        name,
        "--split",
        "0.7,0.15,0.15",
        "--seed",
        "42",
    )
    assert document["split"]["seed"] == 42


def test_no_split_leaves_it_null(root: Path, tmp_path: Path) -> None:
    name = promoted_project(root, tmp_path)
    assert payload(root, "release", "publish", "--tag", "v1.0", "-p", name)["split"] is None


@pytest.mark.parametrize(
    ("value", "why"),
    [
        ("0.5,0.5", "too few"),
        ("0.5,0.25,0.15,0.1", "too many"),
        ("a,b,c", "not numbers"),
        ("0.5,0.5,0.5", "does not add up"),
    ],
)
def test_a_malformed_split_exits_two(root: Path, tmp_path: Path, value: str, why: str) -> None:
    # ``SplitRecipe`` refuses the last one with a pydantic error, which is not a
    # ``VisionSetError`` and would print a traceback.
    name = promoted_project(root, tmp_path)
    result = run(root, "release", "publish", "--tag", "v1.0", "-p", name, "--split", value)
    assert result.exit_code == 2, f"{why}: {result.output}"


# --- list --------------------------------------------------------------------


def test_list_leads_with_the_id(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    rows = ok(root, "release", "list", "-p", name).splitlines()
    assert rows[0].split() == ["ID", "TAG", "ASSETS", "ANNOTATIONS", "SCHEMA", "CREATED"]
    assert rows[1].split()[1] == "v1.0"


def test_an_empty_listing_still_prints_its_header(root: Path, tmp_path: Path) -> None:
    name = promoted_project(root, tmp_path)
    result = run(root, "release", "list", "-p", name)
    assert len(result.stdout.splitlines()) == 1
    assert "published no releases" in result.stderr


def test_list_json_is_the_envelope(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    document = payload(root, "release", "list", "-p", name)
    assert document["total"] == 1
    assert document["items"][0]["tag"] == "v1.0"


# --- verify: the exit code is the answer -------------------------------------


def test_verify_exits_zero_when_the_release_is_intact(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    result = run(root, "release", "verify", "v1.0", "-p", name)
    assert result.exit_code == 0, result.output
    assert "verifies" in result.stderr


def test_verify_json_carries_the_derived_ok(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    document = payload(root, "release", "verify", "v1.0", "-p", name)
    assert document["ok"] is True
    assert document["checked"] == 6


def test_verify_exits_one_when_the_manifest_has_been_altered(root: Path, tmp_path: Path) -> None:
    # Not a refusal — the check ran and the answer is no. Exit 1 is what lets
    # ``verify && train.sh`` mean something.
    name = published_release(root, tmp_path)
    _manifest_blob(root, name, "v1.0").write_bytes(b"{}")
    result = run(root, "release", "verify", "v1.0", "-p", name)
    assert result.exit_code == 1, result.output
    assert "does not match its hash" in result.stderr


def test_verify_json_still_prints_when_the_answer_is_no(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    _manifest_blob(root, name, "v1.0").write_bytes(b"{}")
    result = run(root, "release", "verify", "v1.0", "-p", name, "--json")
    assert result.exit_code == 1, result.output
    assert '"ok": false' in result.stdout


def test_an_unknown_tag_exits_one(root: Path, tmp_path: Path) -> None:
    name = published_release(root, tmp_path)
    result = run(root, "release", "verify", "v9.9", "-p", name)
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr
