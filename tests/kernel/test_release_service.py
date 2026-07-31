"""ReleaseService: freezing the trunk, and proving the freeze held.

Every release here is published through the real path — a batch approved,
annotated, completed and promoted — because the thing under test is what a
snapshot of *that* looks like, and a hand-written membership row would prove
nothing about it.

Tampering is done by writing to the blob file directly. That is the only way to
produce the fault ``verify`` exists to find: nothing in the kernel can corrupt a
blob, which is exactly why nothing in the kernel can be trusted to notice.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from visionset import __version__, wire
from visionset.kernel import (
    ConfirmationRequired,
    DatasetNotFound,
    EmptyRelease,
    InvalidName,
    LossyExportNotConsented,
    NoSplitRecipe,
    ReleaseNotFound,
    ReleaseTagTaken,
    SchemaNotFound,
    WorkspaceCorrupt,
)
from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    Asset,
    AssetProgress,
    BboxGeometry,
    ExportCompatibility,
    GeometryType,
    LabelClass,
    Manifest,
    PolygonGeometry,
    Release,
    SplitRecipe,
    canonical_bytes,
    sha256_hex,
)
from visionset.kernel.services import (
    EXPORT_REPORT_FILENAME,
    AnnotationService,
    BatchService,
    DatasetService,
    JobService,
    ProjectService,
    ReleaseService,
    SchemaService,
    WorkspaceService,
)

SIGN = LabelClass(name="sign", geometry=GeometryType.BBOX)
RECIPE = SplitRecipe(train=0.6, val=0.2, test=0.2, seed=42)


class Fixture:
    """A workspace whose one batch can be walked to ``completed`` and promoted."""

    def __init__(self, tmp_path: Path, name: str = "ws", *, assets: int = 5) -> None:
        self.root = tmp_path / name
        self.workspace = WorkspaceService.init(self.root)
        self.projects = ProjectService(self.workspace)
        self.schemas = SchemaService(self.workspace)
        self.batches = BatchService(self.workspace)
        self.jobs = JobService(self.workspace)
        self.annotations = AnnotationService(self.workspace)
        self.datasets = DatasetService(self.workspace)
        self.releases = ReleaseService(self.workspace)
        self.project = self.projects.create(f"{name}-project")
        self.asset_ids = [self._asset(f"{name}-{index}") for index in range(assets)]

    @property
    def dataset_id(self) -> UUID:
        return self.projects.get_dataset(self.project.id).id

    def _asset(self, seed: str) -> UUID:
        content_hash = self.workspace.blob_store.put(BytesIO(seed.encode()))
        with self.workspace.unit_of_work() as uow:
            return uow.assets.add(
                Asset(
                    project_id=self.project.id,
                    content_hash=content_hash,
                    uri=f"/tmp/{seed}.png",
                    width=640,
                    height=480,
                )
            ).id

    def promote(self, asset_ids: list[UUID] | None = None, *, name: str = "first") -> AnnotationJob:
        """Take one batch all the way from draft to a promoted, labeled trunk."""
        chosen = self.asset_ids if asset_ids is None else asset_ids
        batch = self.batches.create(self.project.id, name, chosen)
        self.batches.approve(batch.id)
        (job,) = self.batches.jobs(batch.id)
        self.batches.start(batch.id)
        self.jobs.start(job.id)
        for asset_id in chosen:
            self.annotations.add(job.id, [_box(asset_id)])
        self.jobs.complete(job.id)
        self.batches.complete(batch.id)
        self.datasets.promote(batch.id)
        return job

    def ready(self) -> UUID:
        """A schema, a promoted batch, and the dataset id to publish from."""
        self.schemas.create_version(self.project.id, [SIGN])
        self.promote()
        return self.dataset_id

    def blob_path(self, content_hash: str) -> Path:
        return self.root / "blobs" / content_hash[:2] / content_hash[2:4] / content_hash

    def close(self) -> None:
        self.workspace.close()


def _box(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="sign",
        schema_version=1,
        geometry=BboxGeometry(x=1.0, y=2.0, width=30.0, height=40.0),
        provenance="human",
    )


# --- what publishing freezes --------------------------------------------------


def test_publishing_writes_the_manifest_into_the_blob_store_and_points_at_it(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")

    assert fixture.workspace.blob_store.exists(release.manifest_hash)
    manifest = fixture.releases.manifest(release.id)
    assert isinstance(manifest, Manifest)
    assert fixture.blob_path(release.manifest_hash).read_bytes() == canonical_bytes(manifest)
    fixture.close()


def test_publishing_twice_from_an_unchanged_dataset_yields_byte_identical_manifests(
    tmp_path: Path,
) -> None:
    """The acceptance criterion, and a consequence of what the document omits."""
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    first = fixture.releases.publish(dataset_id, "v1")
    second = fixture.releases.publish(dataset_id, "v2")

    assert first.manifest_hash == second.manifest_hash
    assert canonical_bytes(fixture.releases.manifest(first.id)) == canonical_bytes(
        fixture.releases.manifest(second.id)
    )
    fixture.close()


def test_publishing_twice_from_an_unchanged_dataset_reuses_the_one_manifest_blob(
    tmp_path: Path,
) -> None:
    """Content-addressed storage makes the byte-identity visible on disk."""
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    fixture.releases.publish(dataset_id, "v1")
    fixture.releases.publish(dataset_id, "v2")

    stored = {path.name for path in (fixture.root / "blobs").rglob("*") if path.is_file()}
    assert len(stored) == len(fixture.asset_ids) + 1  # the assets, and one manifest
    fixture.close()


def test_a_release_records_the_date_and_the_visionset_version_that_made_it(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    before = datetime.now(UTC)
    release = fixture.releases.publish(fixture.ready(), "v1")

    assert release.visionset_version == __version__
    assert release.created_at.tzinfo is not None
    assert before <= release.created_at <= datetime.now(UTC)
    fixture.close()


def test_the_manifest_lists_every_promoted_asset_with_its_content_hash(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")

    manifest = fixture.releases.manifest(release.id)
    assert {asset.asset_id for asset in manifest.assets} == set(fixture.asset_ids)
    for asset in manifest.assets:
        assert fixture.workspace.blob_store.exists(asset.content_hash)
        assert asset.width == 640 and asset.height == 480
    assert release.asset_count == len(fixture.asset_ids)
    fixture.close()


def test_the_manifest_copies_the_annotations_rather_than_pointing_at_them(
    tmp_path: Path,
) -> None:
    """Labeling the same asset again afterwards must not reach into the release.

    A second batch over an asset already in the trunk is the only way to change
    its labels once the first batch closed — which is the point: the live set
    moves on, and the frozen one does not.
    """
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    release = fixture.releases.publish(dataset_id, "v1")
    assert release.annotation_count == len(fixture.asset_ids)

    frozen = fixture.releases.manifest(release.id)
    revisited = frozen.assets[0].asset_id
    (label,) = frozen.assets[0].annotations
    assert label.label_class == "sign"

    fixture.promote([revisited], name="second pass")
    later = fixture.releases.publish(dataset_id, "v2")
    assert later.annotation_count == len(fixture.asset_ids) + 1

    assert fixture.releases.manifest(release.id) == frozen
    assert fixture.releases.get(release.id).annotation_count == len(fixture.asset_ids)
    fixture.close()


def test_the_manifest_pins_the_schema_version_in_force_when_it_was_published(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    fixture.schemas.create_version(
        fixture.project.id, [SIGN, LabelClass(name="lane", geometry=GeometryType.POLYGON)]
    )
    release = fixture.releases.publish(dataset_id, "v1")

    manifest = fixture.releases.manifest(release.id)
    assert manifest.schema_version == 2
    assert {label_class.name for label_class in manifest.classes} == {"sign", "lane"}
    assert release.schema_version == 2
    fixture.close()


def test_curating_an_asset_out_of_the_trunk_leaves_a_published_manifest_alone(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    release = fixture.releases.publish(dataset_id, "v1")
    frozen = fixture.releases.manifest(release.id)

    fixture.datasets.remove_asset(dataset_id, fixture.asset_ids[0])
    assert len(fixture.datasets.assets(dataset_id)) == len(fixture.asset_ids) - 1
    assert fixture.releases.manifest(release.id) == frozen
    assert fixture.releases.get(release.id).asset_count == len(fixture.asset_ids)
    fixture.close()


def test_promoting_a_second_batch_does_not_change_an_earlier_release(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(fixture.project.id, [SIGN])
    fixture.promote(fixture.asset_ids[:3], name="first")
    release = fixture.releases.publish(fixture.dataset_id, "v1")
    assert release.asset_count == 3

    fixture.promote(fixture.asset_ids[3:], name="second")
    assert fixture.releases.manifest(release.id).assets != ()
    assert len(fixture.releases.manifest(release.id).assets) == 3
    assert (
        len(fixture.releases.manifest(fixture.releases.publish(fixture.dataset_id, "v2").id).assets)
        == 5
    )
    fixture.close()


# --- reading a release back by its tag ----------------------------------------


def test_a_release_reads_back_by_its_tag(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    assert fixture.releases.get_by_tag(fixture.dataset_id, "v1") == release
    fixture.close()


def test_a_tag_resolves_after_normalization(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    assert fixture.releases.get_by_tag(fixture.dataset_id, "  v1  ") == release
    fixture.close()


def test_a_tag_is_matched_case_sensitively(tmp_path: Path) -> None:
    # The opposite of ``ProjectService.get_by_name``, and deliberately so: a tag
    # is an identifier rather than a label somebody reads, and the unique index
    # compares it exactly. Both rules live beside the index that enforces them so
    # that no surface has to re-derive either.
    fixture = Fixture(tmp_path)
    upper = fixture.releases.publish(fixture.ready(), "V1")
    with pytest.raises(ReleaseNotFound):
        fixture.releases.get_by_tag(fixture.dataset_id, "v1")
    assert fixture.releases.get_by_tag(fixture.dataset_id, "V1") == upper
    fixture.close()


def test_getting_an_unknown_tag_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.releases.publish(fixture.ready(), "v1")
    with pytest.raises(ReleaseNotFound, match="no release tagged"):
        fixture.releases.get_by_tag(fixture.dataset_id, "v2")
    fixture.close()


@pytest.mark.parametrize("blank", ["", "   "])
def test_getting_a_blank_tag_is_refused_as_a_name(tmp_path: Path, blank: str) -> None:
    fixture = Fixture(tmp_path)
    fixture.releases.publish(fixture.ready(), "v1")
    with pytest.raises(InvalidName):
        fixture.releases.get_by_tag(fixture.dataset_id, blank)
    fixture.close()


def test_getting_a_tag_from_an_unknown_dataset_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.releases.publish(fixture.ready(), "v1")
    with pytest.raises(DatasetNotFound):
        fixture.releases.get_by_tag(uuid4(), "v1")
    fixture.close()


# --- what publishing refuses --------------------------------------------------


def test_publishing_a_dataset_with_nothing_in_it_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(fixture.project.id, [SIGN])
    with pytest.raises(EmptyRelease, match="no assets"):
        fixture.releases.publish(fixture.dataset_id, "v1")
    fixture.close()


def test_publishing_from_a_project_that_has_no_schema_is_refused(tmp_path: Path) -> None:
    """The schema gate fires before the emptiness one, and an empty trunk proves it."""
    fixture = Fixture(tmp_path)
    with pytest.raises(SchemaNotFound):
        fixture.releases.publish(fixture.dataset_id, "v1")
    fixture.close()


def test_a_dataset_cannot_have_two_releases_under_one_tag(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    fixture.releases.publish(dataset_id, "v1")
    with pytest.raises(ReleaseTagTaken, match="already has a release tagged"):
        fixture.releases.publish(dataset_id, "v1")
    fixture.close()


def test_two_tags_differing_only_in_case_are_two_releases(tmp_path: Path) -> None:
    """A tag is an identifier, like a git tag — not a display name."""
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    fixture.releases.publish(dataset_id, "v1.0")
    assert fixture.releases.publish(dataset_id, "V1.0").tag == "V1.0"
    fixture.close()


def test_the_same_tag_in_two_datasets_is_two_different_releases(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    first = fixture.ready()

    other = fixture.projects.create("second-project")
    fixture.schemas.create_version(other.id, [SIGN])
    content_hash = fixture.workspace.blob_store.put(BytesIO(b"other"))
    with fixture.workspace.unit_of_work() as uow:
        asset = uow.assets.add(
            Asset(project_id=other.id, content_hash=content_hash, uri="/tmp/other.png")
        )
    batch = fixture.batches.create(other.id, "b", [asset.id])
    fixture.batches.approve(batch.id)
    (job,) = fixture.batches.jobs(batch.id)
    fixture.batches.start(batch.id)
    fixture.jobs.start(job.id)
    fixture.jobs.mark(job.id, asset.id, AssetProgress.ANNOTATED)
    fixture.jobs.complete(job.id)
    fixture.batches.complete(batch.id)
    fixture.datasets.promote(batch.id)
    second = fixture.projects.get_dataset(other.id).id

    assert fixture.releases.publish(first, "v1").id != fixture.releases.publish(second, "v1").id
    fixture.close()


def test_a_release_tag_is_normalized_the_way_every_other_name_is(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    assert fixture.releases.publish(dataset_id, "  v1  ").tag == "v1"
    with pytest.raises(InvalidName):
        fixture.releases.publish(dataset_id, "   ")
    fixture.close()


def test_a_published_release_cannot_be_edited(tmp_path: Path) -> None:
    """The refusal is the type's; there is no service method here to guard."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    with pytest.raises(ValueError, match="frozen"):
        release.tag = "v2"  # type: ignore[misc]
    assert not hasattr(fixture.releases, "delete")
    assert not hasattr(fixture.releases, "update")
    fixture.close()


def test_publishing_does_not_take_a_confirmation(tmp_path: Path) -> None:
    """``confirm=`` guards destroying data, and publishing destroys nothing."""
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    try:
        fixture.releases.publish(dataset_id, "v1")
    except ConfirmationRequired:  # pragma: no cover - the point is that it does not
        pytest.fail("publishing asked for a confirmation it has no business asking for")
    fixture.close()


def test_publishing_writes_no_entry_into_the_dataset_change_log(tmp_path: Path) -> None:
    """The log records mutations of the trunk, and a release mutates nothing."""
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    before = len(fixture.datasets.changes(dataset_id))
    fixture.releases.publish(dataset_id, "v1")
    assert len(fixture.datasets.changes(dataset_id)) == before
    fixture.close()


# --- verification -------------------------------------------------------------


def test_verify_passes_for_a_release_nobody_has_touched(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    report = fixture.releases.verify(fixture.releases.publish(fixture.ready(), "v1").id)

    assert report.ok
    assert report.manifest_intact
    assert report.checked == len(fixture.asset_ids)
    assert report.missing == () and report.corrupt == () and report.cache_mismatches == ()
    fixture.close()


def test_verify_reports_a_tampered_asset_blob_as_corrupt(tmp_path: Path) -> None:
    """The acceptance criterion: a rewritten blob is caught, not assumed intact."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    victim = fixture.releases.manifest(release.id).assets[0].content_hash
    fixture.blob_path(victim).write_bytes(b"not what it says it is")

    report = fixture.releases.verify(release.id)
    assert not report.ok
    assert report.corrupt == (victim,)
    assert report.missing == ()
    assert report.checked == len(fixture.asset_ids)
    fixture.close()


def test_verify_reports_an_absent_asset_blob_as_missing_not_as_corrupt(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    victim = fixture.releases.manifest(release.id).assets[0].content_hash
    fixture.blob_path(victim).unlink()

    report = fixture.releases.verify(release.id)
    assert not report.ok
    assert report.missing == (victim,)
    assert report.corrupt == ()
    fixture.close()


def test_verify_reports_a_tampered_manifest_and_stops_before_trusting_it(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    fixture.blob_path(release.manifest_hash).write_bytes(b'{"schema_version": 1}')

    report = fixture.releases.verify(release.id)
    assert not report.ok
    assert not report.manifest_intact
    assert report.checked == 0
    assert report.missing == () and report.corrupt == ()
    fixture.close()


def test_reading_a_manifest_whose_blob_is_gone_is_corruption_not_a_file_error(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    fixture.blob_path(release.manifest_hash).unlink()

    with pytest.raises(WorkspaceCorrupt, match="not in the blob store"):
        fixture.releases.manifest(release.id)
    with pytest.raises(WorkspaceCorrupt):
        fixture.releases.verify(release.id)
    fixture.close()


def test_reading_a_manifest_that_is_not_a_manifest_is_corruption(tmp_path: Path) -> None:
    """A ``JSONDecodeError`` reaching a caller would break the kernel's vocabulary."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    fixture.blob_path(release.manifest_hash).write_bytes(b"not json at all")

    with pytest.raises(WorkspaceCorrupt, match="not a readable manifest"):
        fixture.releases.manifest(release.id)
    fixture.close()


# --- the split ----------------------------------------------------------------


def test_the_split_is_taken_from_the_frozen_asset_set_not_from_the_trunk_today(
    tmp_path: Path,
) -> None:
    """Curating after publication must not move a published release's folds."""
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    release = fixture.releases.publish(dataset_id, "v1", split=RECIPE)
    before = fixture.releases.assignment(release.id)

    fixture.datasets.remove_asset(dataset_id, fixture.asset_ids[0])
    assert fixture.releases.assignment(release.id) == before
    everywhere = [*before.train, *before.val, *before.test]
    assert set(everywhere) == set(fixture.asset_ids)
    fixture.close()


def test_the_same_release_hands_back_the_same_split_every_time_it_is_asked(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1", split=RECIPE)
    assert fixture.releases.assignment(release.id) == fixture.releases.assignment(release.id)
    fixture.close()


def test_two_releases_of_one_asset_set_under_one_seed_split_it_the_same_way(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    first = fixture.releases.publish(dataset_id, "v1", split=RECIPE)
    second = fixture.releases.publish(dataset_id, "v2", split=RECIPE)
    assert fixture.releases.assignment(first.id) == fixture.releases.assignment(second.id)
    fixture.close()


def test_a_release_published_without_a_recipe_has_no_split_to_give(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    assert release.split is None
    with pytest.raises(NoSplitRecipe, match="undivided"):
        fixture.releases.assignment(release.id)
    fixture.close()


def test_a_split_recipe_survives_the_round_trip_through_storage(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1", split=RECIPE)
    assert fixture.releases.get(release.id).split == RECIPE
    fixture.close()


# --- reading, scoping and lifecycle -------------------------------------------


def test_listing_a_datasets_releases_gives_them_oldest_first(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    for tag in ("v1", "v2", "v3"):
        fixture.releases.publish(dataset_id, tag)
    assert [release.tag for release in fixture.releases.list(dataset_id)] == ["v1", "v2", "v3"]
    fixture.close()


def test_a_dataset_with_no_releases_lists_nothing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    assert fixture.releases.list(fixture.dataset_id) == []
    fixture.close()


def test_a_release_id_that_is_not_stored_reads_as_missing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(ReleaseNotFound):
        fixture.releases.get(uuid4())
    fixture.close()


def test_another_workspaces_release_reads_as_missing(tmp_path: Path) -> None:
    """Not forbidden — the rule every cross-scope reference in the kernel follows."""
    here, there = Fixture(tmp_path, "here"), Fixture(tmp_path, "there")
    stranger = there.releases.publish(there.ready(), "v1")

    with pytest.raises(ReleaseNotFound):
        here.releases.get(stranger.id)
    with pytest.raises(DatasetNotFound):
        here.releases.list(there.dataset_id)
    here.close()
    there.close()


def test_deleting_the_project_takes_its_releases_with_it(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    dataset_id = fixture.ready()
    release = fixture.releases.publish(dataset_id, "v1")
    fixture.projects.delete(fixture.project.id, confirm=True)

    with pytest.raises(ReleaseNotFound):
        fixture.releases.get(release.id)
    fixture.close()


def test_a_manifest_blob_outlives_the_release_that_named_it(tmp_path: Path) -> None:
    """Blobs are never deleted; deleting metadata frees rows, not disk."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    fixture.projects.delete(fixture.project.id, confirm=True)
    assert fixture.workspace.blob_store.exists(release.manifest_hash)
    fixture.close()


# --- handing the snapshot to a format plugin ----------------------------------


class _Recording:
    """An exporter that writes two files and remembers what it was handed."""

    format_name = "recording"
    lossy = False
    #: #65's capability declaration. Everything, so this double's subject stays
    #: what it was rather than a geometry report nobody wrote this test for.
    supported_geometries = frozenset(GeometryType)
    supported_modalities = frozenset({"image"})

    def __init__(self) -> None:
        self.calls: list[tuple[UUID, int, Path]] = []

    def export(self, release: Release, manifest: Manifest, dest: Path) -> None:
        self.calls.append((release.id, len(manifest.assets), dest))
        (dest / "top.txt").write_text("x" * 10)
        # ``exist_ok`` because the port says so: ``dest`` may already hold an
        # earlier run's output, and the kernel will not delete under a path a
        # caller named.
        (dest / "nested").mkdir(exist_ok=True)
        (dest / "nested" / "deep.txt").write_text("y" * 5)


class _Lossy:
    """Declares itself lossy, so the consent gate has something to refuse."""

    format_name = "lossy"
    lossy = True
    #: #65's capability declaration. Everything, so this double's subject stays
    #: what it was rather than a geometry report nobody wrote this test for.
    supported_geometries = frozenset(GeometryType)
    supported_modalities = frozenset({"image"})

    def __init__(self) -> None:
        self.called = False

    def export(self, release: Release, manifest: Manifest, dest: Path) -> None:
        self.called = True
        (dest / "partial.txt").write_text("boxes only")


def test_export_hands_the_plugin_the_release_and_its_resolved_manifest(tmp_path: Path) -> None:
    """The manifest arrives beside the release, because a release only names one."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    exporter = _Recording()
    dest = tmp_path / "out"

    fixture.releases.export(release.id, exporter, dest)

    assert exporter.calls == [(release.id, len(fixture.asset_ids), dest)]
    fixture.close()


def test_export_creates_the_destination_it_was_given(tmp_path: Path) -> None:
    """Including its parents: a caller naming a nested path does not have to mkdir first."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    dest = tmp_path / "exports" / str(release.id) / "recording"

    fixture.releases.export(release.id, _Recording(), dest)

    assert (dest / "top.txt").is_file()
    fixture.close()


def test_export_counts_what_was_written_rather_than_asking_the_plugin(tmp_path: Path) -> None:
    """Walked with rglob, so an exporter using subdirectories is counted correctly."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")

    result = fixture.releases.export(release.id, _Recording(), tmp_path / "out")

    assert result.file_count == 2
    assert result.total_bytes == 15
    assert result.format_name == "recording"
    assert result.release_id == release.id
    assert result.directory == tmp_path / "out"
    fixture.close()


def test_an_exporter_that_writes_nothing_reports_zero(tmp_path: Path) -> None:
    """``DummyExporter``'s shape. Reporting zero is the honest answer, not a failure."""

    class _Silent:
        format_name = "silent"
        lossy = False
        #: #65's capability declaration. Everything, so this double's subject stays
        #: what it was rather than a geometry report nobody wrote this test for.
        supported_geometries = frozenset(GeometryType)
        supported_modalities = frozenset({"image"})

        def export(self, release: Release, manifest: Manifest, dest: Path) -> None:
            return None

    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")

    result = fixture.releases.export(release.id, _Silent(), tmp_path / "out")

    assert (result.file_count, result.total_bytes) == (0, 0)
    fixture.close()


def test_a_lossy_format_is_refused_without_consent(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    exporter = _Lossy()

    with pytest.raises(LossyExportNotConsented, match="lossy"):
        fixture.releases.export(release.id, exporter, tmp_path / "out")
    fixture.close()


def test_a_refused_lossy_export_leaves_nothing_behind(tmp_path: Path) -> None:
    """Checked before anything is created, so a retry does not find a half-written run."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    exporter = _Lossy()
    dest = tmp_path / "out"

    with pytest.raises(LossyExportNotConsented):
        fixture.releases.export(release.id, exporter, dest)

    assert not dest.exists()
    assert exporter.called is False
    fixture.close()


def test_a_lossy_format_exports_once_the_caller_consents(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")

    result = fixture.releases.export(release.id, _Lossy(), tmp_path / "out", allow_lossy=True)

    assert result.file_count == 1
    fixture.close()


def test_consenting_to_loss_is_harmless_for_a_lossless_format(tmp_path: Path) -> None:
    """The flag permits, it does not request — so it changes nothing when nothing is lost."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")

    with_flag = fixture.releases.export(release.id, _Recording(), tmp_path / "a", allow_lossy=True)
    without = fixture.releases.export(release.id, _Recording(), tmp_path / "b")

    assert (with_flag.file_count, with_flag.total_bytes) == (
        without.file_count,
        without.total_bytes,
    )
    fixture.close()


def test_exporting_an_unknown_release_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(ReleaseNotFound):
        fixture.releases.export(uuid4(), _Recording(), tmp_path / "out")
    fixture.close()


def test_exporting_twice_into_one_directory_agrees_with_itself(tmp_path: Path) -> None:
    """Nothing is recorded, so a release is not changed by having been exported.

    Re-running into the same directory is the case the port's ``exist_ok`` note
    exists for, and here it is exercised rather than described.
    """
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")

    first = fixture.releases.export(release.id, _Recording(), tmp_path / "out")
    second = fixture.releases.export(release.id, _Recording(), tmp_path / "out")

    assert first == second
    assert fixture.releases.get(release.id) == release
    fixture.close()


def test_a_stale_file_in_the_destination_is_counted_and_not_deleted(tmp_path: Path) -> None:
    """The kernel does not empty a directory a caller named, and says so in the counts.

    Clearing it belongs to whoever owns the path — the REST route does exactly
    that, which is why its archive describes one run and this does not.
    """
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    dest = tmp_path / "out"
    dest.mkdir()
    (dest / "left-over.txt").write_text("from an earlier format")

    result = fixture.releases.export(release.id, _Recording(), dest)

    assert result.file_count == 3
    assert (dest / "left-over.txt").is_file()
    fixture.close()


def test_export_reads_the_manifest_and_says_so_when_it_is_gone(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    fixture.blob_path(release.manifest_hash).unlink()

    with pytest.raises(WorkspaceCorrupt):
        fixture.releases.export(release.id, _Recording(), tmp_path / "out")
    fixture.close()


# --- the manifest as bytes, not as a parsed document --------------------------


def test_open_manifest_hands_back_exactly_what_the_hash_names(tmp_path: Path) -> None:
    """The byte-identical round trip: what comes out re-hashes to ``manifest_hash``."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")

    with fixture.releases.open_manifest(release) as stream:
        raw = stream.read()

    assert sha256_hex(raw) == release.manifest_hash
    assert raw == canonical_bytes(fixture.releases.manifest(release.id))
    fixture.close()


def test_open_manifest_says_the_workspace_is_damaged_when_the_blob_is_gone(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    fixture.blob_path(release.manifest_hash).unlink()

    with pytest.raises(WorkspaceCorrupt):
        fixture.releases.open_manifest(release)
    fixture.close()


# --- what a format would drop (#65) -------------------------------------------


class _BoxesOnly:
    """Declares itself lossless and can only write boxes.

    The pair #65 exists for. ``lossy`` is false, so nothing about the *format*
    asks for consent — everything that happens below happens because of what this
    particular release holds.
    """

    format_name = "boxes-only"
    lossy = False
    supported_geometries = frozenset({GeometryType.BBOX})
    supported_modalities = frozenset({"image"})

    def export(self, release: Release, manifest: Manifest, dest: Path) -> None:
        (dest / "boxes.txt").write_text("ok", encoding="utf-8")


def _polygon(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="lane",
        schema_version=1,
        geometry=PolygonGeometry(points=[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]),
        provenance="human",
    )


def _mixed(fixture: Fixture) -> UUID:
    """A release holding boxes on every asset and polygons on the first two."""
    fixture.schemas.create_version(
        fixture.project.id, [SIGN, LabelClass(name="lane", geometry=GeometryType.POLYGON)]
    )
    batch = fixture.batches.create(fixture.project.id, "mixed", fixture.asset_ids)
    fixture.batches.approve(batch.id)
    (job,) = fixture.batches.jobs(batch.id)
    fixture.batches.start(batch.id)
    fixture.jobs.start(job.id)
    for index, asset_id in enumerate(fixture.asset_ids):
        written = [_box(asset_id)] + ([_polygon(asset_id)] if index < 2 else [])
        fixture.annotations.add(job.id, written)
    fixture.jobs.complete(job.id)
    fixture.batches.complete(batch.id)
    fixture.datasets.promote(batch.id)
    return fixture.dataset_id


def test_a_clean_report_names_every_class_with_its_counts(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")

    report = fixture.releases.check_export(release.id, _BoxesOnly())

    assert report.compatible
    assert (report.excluded_annotations, report.excluded_assets) == (0, 0)
    assert report.excluded == ()
    (sign,) = report.classes
    assert (sign.label_class, sign.supported, sign.annotations, sign.assets) == (
        "sign",
        True,
        5,
        5,
    )
    # Filled only where something is wrong. An empty string here would read as a
    # reason somebody forgot to write.
    assert sign.reason is None
    fixture.close()


def test_the_report_counts_annotations_and_assets_separately(tmp_path: Path) -> None:
    """Two polygons over two assets, out of five assets carrying boxes as well."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(_mixed(fixture), "v1")

    report = fixture.releases.check_export(release.id, _BoxesOnly())

    assert not report.compatible
    assert (report.excluded_annotations, report.excluded_assets) == (2, 2)
    (lane,) = report.excluded
    assert (lane.label_class, lane.annotations, lane.assets) == ("lane", 2, 2)
    assert lane.reason == "boxes-only cannot write polygon geometry"
    # Sorted by name, so two reports of one release are the same document.
    assert [one.label_class for one in report.classes] == ["lane", "sign"]
    fixture.close()


def test_a_class_nobody_used_excludes_nothing_however_unsupported(tmp_path: Path) -> None:
    """The report's least obvious property, and the one that keeps it honest.

    A schema declaring ``lane`` does not make every export of that project lossy.
    The row is still published, with its zero, because "this format cannot write
    polygons and you have none" is an answer somebody is looking for.
    """
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(
        fixture.project.id, [SIGN, LabelClass(name="lane", geometry=GeometryType.POLYGON)]
    )
    fixture.promote()
    release = fixture.releases.publish(fixture.dataset_id, "v1")

    report = fixture.releases.check_export(release.id, _BoxesOnly())

    assert report.compatible
    assert report.excluded == ()
    lane = next(one for one in report.classes if one.label_class == "lane")
    assert (lane.supported, lane.annotations, lane.assets) == (False, 0, 0)
    # Unsupported and harmless: the reason is still there, because the row is
    # about the format's capabilities and those do not depend on the data.
    assert lane.reason is not None
    fixture.close()


def test_check_export_writes_nothing_at_all(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(_mixed(fixture), "v1")
    dest = tmp_path / "out"

    fixture.releases.check_export(release.id, _BoxesOnly())

    assert not dest.exists()
    fixture.close()


def test_a_lossless_format_that_would_drop_a_class_is_still_refused(tmp_path: Path) -> None:
    """#65's whole point: ``lossy`` is a blanket claim, and this is about the data."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(_mixed(fixture), "v1")

    with pytest.raises(LossyExportNotConsented) as refusal:
        fixture.releases.export(release.id, _BoxesOnly(), tmp_path / "out")

    assert not (tmp_path / "out").exists()
    fixture.close()
    # The report travels on the refusal, so a caller can say what it is consenting
    # to without a second call.
    carried = refusal.value.compatibility
    assert isinstance(carried, ExportCompatibility)
    assert carried.excluded_annotations == 2
    assert [one.label_class for one in carried.excluded] == ["lane"]


def test_a_lossless_format_over_a_release_it_can_carry_needs_no_consent(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")

    result = fixture.releases.export(release.id, _BoxesOnly(), tmp_path / "out")

    assert result.compatibility.compatible
    fixture.close()


def test_consent_lets_the_incompatible_export_through(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(_mixed(fixture), "v1")

    result = fixture.releases.export(release.id, _BoxesOnly(), tmp_path / "out", allow_lossy=True)

    assert not result.compatibility.compatible
    assert result.compatibility.excluded_annotations == 2
    fixture.close()


def test_the_report_is_written_into_the_export_directory(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(_mixed(fixture), "v1")
    dest = tmp_path / "out"

    result = fixture.releases.export(release.id, _BoxesOnly(), dest, allow_lossy=True)

    written = json.loads((dest / EXPORT_REPORT_FILENAME).read_text(encoding="utf-8"))
    assert written["compatible"] is False
    assert written["excluded_annotations"] == 2
    # Key-for-key what `visionset.wire` hands the CLI and MCP, and what
    # `ExportCompatibilityOut` puts on the API's refusal. One document, four
    # places — which is #65's "report format stable" acceptance criterion, and it
    # is the reason `format_name` carries a serialization alias.
    assert written == wire.export_compatibility(result.compatibility)
    fixture.close()


def test_the_report_parses_back_into_the_model_that_wrote_it(tmp_path: Path) -> None:
    """The alias has a way in as well as out, or the file would be write-only."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(_mixed(fixture), "v1")
    dest = tmp_path / "out"

    result = fixture.releases.export(release.id, _BoxesOnly(), dest, allow_lossy=True)

    written = (dest / EXPORT_REPORT_FILENAME).read_text(encoding="utf-8")
    assert ExportCompatibility.model_validate_json(written) == result.compatibility
    fixture.close()


def test_the_report_is_not_counted_as_something_the_plugin_wrote(tmp_path: Path) -> None:
    """``file_count`` describes the exporter's output, so the kernel's own file is out."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    dest = tmp_path / "out"

    result = fixture.releases.export(release.id, _BoxesOnly(), dest)

    assert (dest / EXPORT_REPORT_FILENAME).is_file()
    assert result.file_count == 1
    fixture.close()


def test_exporting_twice_into_one_directory_still_agrees_with_itself(tmp_path: Path) -> None:
    """The other half of the exclusion: a report left by the first run is skipped."""
    fixture = Fixture(tmp_path)
    release = fixture.releases.publish(fixture.ready(), "v1")
    dest = tmp_path / "out"

    first = fixture.releases.export(release.id, _BoxesOnly(), dest)
    second = fixture.releases.export(release.id, _BoxesOnly(), dest)

    assert (first.file_count, first.total_bytes) == (second.file_count, second.total_bytes)
    fixture.close()


def test_a_report_is_computed_from_the_frozen_manifest_not_from_live_membership(
    tmp_path: Path,
) -> None:
    """An export describes a release, and a release is a snapshot.

    Curating an asset out of the trunk after publication must not move the answer:
    the whole property that lets one document be shown in a dialog, attached to a
    refusal and written into an output is that it is derived from the snapshot.
    """
    fixture = Fixture(tmp_path)
    dataset_id = _mixed(fixture)
    release = fixture.releases.publish(dataset_id, "v1")
    before = fixture.releases.check_export(release.id, _BoxesOnly())

    fixture.datasets.remove_asset(dataset_id, fixture.asset_ids[0])

    assert fixture.releases.check_export(release.id, _BoxesOnly()) == before
    fixture.close()


def test_checking_an_unknown_release_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    with pytest.raises(ReleaseNotFound):
        fixture.releases.check_export(uuid4(), _BoxesOnly())
    fixture.close()
