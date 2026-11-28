# usage: from visionset.kernel.services import ReleaseService
"""Releases: freezing a moment of the trunk, and proving it is still that moment.

``DatasetService`` keeps a project's curated trunk honest while it changes. This
service takes it out of time. A published Release is the answer to "which bytes
and which labels did we train on?", and there is no operation here that edits
one — the fix for a wrong release is another release.

Four things shape this module:

- **The manifest goes in the blob store, and the row keeps its hash.** The
  document is the artifact: canonical JSON, content-addressed, verifiable by
  anyone who can read the bytes. Keeping a copy in the row as well would be a
  second thing to trust and a megabyte to load per row when listing. What the row
  does keep — the schema version and the two counts — is a read cache, and
  :meth:`verify` cross-checks it against the document rather than believing it.
- **Publishing is a read of everything and a write of one row.** The whole
  refusal set is checked first, in one order, so a caller who gets an error gets
  the *first* thing wrong rather than whichever check happened to run.
- **Verification re-reads and re-hashes.** ``BlobStore.exists`` answers whether a
  path *named by* a hash is there, which proves nothing about what is in it. A
  content-addressed store does not self-verify; that is what this method is for.
- **Nothing that is not a ``VisionSetError`` escapes.** A manifest blob that is
  gone, a document that will not parse, a document that parses into something
  that is not a manifest: all of those are a release pointing at something the
  workspace should have kept, which is ``WorkspaceCorrupt`` — the same reading a
  broken parent link gets.

There is deliberately no ``delete``. A release is the immutable artifact, and the
only thing that removes one is deleting its project, whose cascade takes it. Even
then the manifest blob survives: blobs are never deleted.

There is also no ``confirm=``. That guard is for destroying data, and publishing
destroys nothing — so this is not a third exemption from ``ConfirmationRequired``
and that docstring stays as it is.

Composition follows the rule in ``docs/content/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

import inspect
import json
import os
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import BinaryIO, Final, Literal
from uuid import UUID

from PIL import __version__ as PILLOW_VERSION
from pydantic import ValidationError

from visionset import __version__
from visionset.kernel.domain import (
    CROPPING_STRATEGIES,
    IMPLEMENTED_GEOMETRIES,
    SHOWCASE_SEED,
    THREE_D,
    Annotation,
    AnnotationSchema,
    Asset,
    AugmentationResolution,
    ClassCompatibility,
    ClassCount,
    ClassExportStatus,
    Dataset,
    ExportCompatibility,
    ExportFileMapping,
    ExportPreprocessing,
    ExportResult,
    ExportTarget,
    GeometryType,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    ManifestObservation,
    ManifestOccurrence,
    ManifestSource,
    ManifestTrack,
    ModalityCompatibility,
    ReasonCode,
    RecipeSpec,
    Release,
    ReleasePublished,
    ReleaseVerification,
    ResizeStep,
    ResizeStrategy,
    SourceKind,
    SplitAssignment,
    SplitRecipe,
    Track,
    TransformedView,
    assign_split,
    canonical_bytes,
    carried_by,
    geometry_needs_calibration,
    geometry_needs_scan_frame,
    incompatible,
    manifest_version_for,
    manifest_within,
    normalize_release_tag,
    plugin_manifest,
    recipe_hash,
    require_calibration,
    require_scan_frame,
    resolve_augmentation,
    sample_plan,
    sha256_hex,
    sha256_hex_of_stream,
    single_tag,
    source_of_content_hash,
    transform_manifest,
    validate_schema_annotation,
    variant_seed,
)
from visionset.kernel.errors import (
    AugmentationIncompatible,
    AugmentationRequiresSplit,
    ConstraintViolated,
    EmptyRelease,
    ExportDestinationNotEmpty,
    ExportDestinationRefused,
    ExportSourceUnreadable,
    InvalidAnnotation,
    LossyExportNotConsented,
    NoSplitRecipe,
    PreprocessingDriverNotFound,
    PreprocessingStepUnsupportedGeometry,
    ReleaseContentWouldViolateSchema,
    ReleaseNotFound,
    ReleaseTagTaken,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import (
    BlobStore,
    ContentReader,
    Exporter,
    PreprocessingDriver,
    UnitOfWork,
    accepts_draw,
    driver_for,
    supported_modalities_of,
)
from visionset.kernel.services.dataset_service import DatasetService, assets_of
from visionset.kernel.services.project_service import ProjectService
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.workspace_service import EXPORTS_DIRNAME, WorkspaceService

#: How SQLite words the tag index's refusal. Matched rather than parsed, and
#: matched exactly, so that a different constraint failing is never mistaken for
#: this one — the ``ProjectService`` precedent.
_TAG_INDEX_MESSAGE = "release.dataset_id, release.tag"


class ReleaseService:
    """Publish immutable snapshots of a dataset, and check they are still intact."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._datasets = DatasetService(workspace)
        self._projects = ProjectService(workspace)
        self._schemas = SchemaService(workspace)

    # --- publishing --------------------------------------------------------

    def publish(self, dataset_id: UUID, tag: str, *, split: SplitRecipe | None = None) -> Release:
        """Freeze the dataset as it stands right now, under ``tag``.

        What gets frozen: every asset currently in the trunk, named by content
        hash; every annotation on those assets, **copied** rather than referenced;
        and the project's active schema version with its classes. Curating the
        trunk afterwards, editing a label, or creating a new schema version
        changes none of it.

        What does not get frozen into the document: the time, the tag and the
        release id. Those live on the row, which is what makes publishing twice
        from an unchanged dataset produce byte-identical manifests — and makes the
        two share one blob, since a content-addressed store deduplicates. The
        acceptance criterion is a consequence of the design rather than a thing
        this method arranges.

        ``split`` is stored, not applied. :meth:`assignment` turns it into folds
        on demand, from this snapshot's frozen asset set.

        :class:`ReleasePublished` is announced once the row has committed, and
        carries ``manifest_hash`` so a subscriber can read the whole snapshot
        without being handed it. There is no dataset change-log entry: publishing
        mutates nothing in the trunk, so "a release happened" is an event.

        The manifest blob is written before the row commits, so a lost tag race
        leaves the document behind with no release naming it. That is benign and
        not worth a compensating delete: the blob is content-addressed, so the
        winner's identical manifest lands on the very same one — and blobs are
        never deleted anyway.

        Args:
            dataset_id: the dataset to snapshot.
            tag: the release's name within that dataset. Normalized like every
                other name, and case-sensitive: a tag is an identifier, not a
                label somebody reads.
            split: how to cut the release for training, if at all.

        Returns:
            The published release.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
            SchemaNotFound: the project has no schema to pin.
            EmptyRelease: the dataset has nothing in it.
            InvalidName: the tag is blank.
            ReleaseTagTaken: this dataset already has a release under that tag.
            UnserializableManifest: an annotation carries a NaN or infinite
                coordinate, which canonical JSON cannot express.
            CalibrationMissing: an asset carrying a 3D label has no calibration,
                neither its own nor its source's.
            CalibrationResolutionMismatch: an asset carrying a 3D label has a
                calibration measured at another size.
            WorkspaceCorrupt: the trunk holds an asset that is not stored.
        """
        cleaned = normalize_release_tag(tag)
        try:
            with self._workspace.unit_of_work() as uow:
                dataset = self._datasets.require_dataset(uow, dataset_id)
                self._require_tag_free(uow, dataset, cleaned)
                active = self._schemas.require_active(uow, dataset.project_id)

                assets = assets_of(uow, dataset)
                if not assets:
                    raise EmptyRelease(
                        f"dataset {dataset.name!r} has no assets; promote a completed batch "
                        f"into it before publishing a release of it"
                    )

                manifest_assets = _manifest_assets(uow, assets)
                blockers = _release_schema_blockers(active, manifest_assets)
                if blockers:
                    raise ReleaseContentWouldViolateSchema(
                        "cannot publish this release: its active schema no longer describes "
                        "annotations in the dataset",
                        blockers=blockers,
                    )

                manifest_tracks = _manifest_tracks(uow, manifest_assets)
                manifest_sources = _manifest_sources(uow, dataset.project_id, manifest_assets)
                manifest = Manifest(
                    manifest_version=manifest_version_for(
                        manifest_assets, manifest_tracks, manifest_sources, active.classes
                    ),
                    schema_version=active.version,
                    classes=active.classes,
                    assets=manifest_assets,
                    tracks=manifest_tracks,
                    sources=manifest_sources,
                )
                project_id = dataset.project_id
                published = uow.releases.add(
                    Release(
                        dataset_id=dataset.id,
                        tag=cleaned,
                        manifest_hash=self._store_manifest(manifest),
                        schema_version=manifest.schema_version,
                        asset_count=len(manifest.assets),
                        annotation_count=manifest.annotation_count,
                        split=split,
                        # Stamped here rather than defaulted in the domain: which
                        # build published a release is a packaging fact, and the
                        # domain has no business knowing about packaging. Same
                        # division as ``AnnotationService`` stamping the pin.
                        visionset_version=__version__,
                    )
                )
        except ConstraintViolated as exc:
            raise self._as_tag_collision(exc, cleaned) from exc

        # After the ``except``, not merely after the ``with``: a lost tag race
        # surfaces at commit time, so announcing any earlier would announce a
        # release that does not exist.
        self._workspace.event_bus.publish(
            ReleasePublished(
                release_id=published.id,
                dataset_id=published.dataset_id,
                project_id=project_id,
                tag=published.tag,
                manifest_hash=published.manifest_hash,
                schema_version=published.schema_version,
                asset_count=published.asset_count,
                annotation_count=published.annotation_count,
            )
        )
        return published

    # --- reading -----------------------------------------------------------

    def get(self, release_id: UUID) -> Release:
        """The release with that id.

        Raises:
            ReleaseNotFound: no such release in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self._require_release(uow, release_id)

    def resolve(self, project_reference: str, tag: str) -> Release:
        """The release under ``tag`` in the dataset of the project a reference names.

        Two lookups, because a tag is unique per dataset and a dataset is reached
        through its project; the project read is what makes an unknown project
        say so instead of reporting a good tag as missing.

        Raises:
            InvalidName: the reference or the tag is blank once stripped.
            ProjectNotFound: no project in this workspace matches.
            ReleaseNotFound: that project's dataset has no release under that tag.
        """
        project = self._projects.resolve(project_reference)
        return self.get_by_tag(self._projects.get_dataset(project.id).id, tag)

    def get_by_tag(self, dataset_id: UUID, tag: str) -> Release:
        """The release published under that tag in that dataset.

        **Case-sensitive**, matching ``publish``: a tag is an identifier, not a
        label somebody reads, and ``uq_release_dataset_tag`` compares it exactly.
        That is the whole reason this lives here rather than in a surface — it is
        the *opposite* rule to ``ProjectService.get_by_name``'s, and a caller
        re-deriving either from prose would eventually get one of them wrong.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
            InvalidName: the tag is blank once stripped.
            ReleaseNotFound: that dataset has no release under that tag.
        """
        cleaned = normalize_release_tag(tag, lookup=True)
        with self._workspace.unit_of_work() as uow:
            dataset = self._datasets.require_dataset(uow, dataset_id)
            for release in uow.releases.list(dataset.id):
                if release.tag == cleaned:
                    return release
        raise ReleaseNotFound(f"dataset {dataset.name!r} has no release tagged {cleaned!r}")

    def manifest(self, release_id: UUID) -> Manifest:
        """The frozen document this release names, read back out of the blob store.

        Raises:
            ReleaseNotFound: no such release in this workspace.
            WorkspaceCorrupt: the manifest blob is gone, or is not a manifest.
        """
        return self._read_manifest(self.get(release_id))

    def verify(self, release_id: UUID) -> ReleaseVerification:
        """Re-read every blob this release names and check it is still itself.

        The manifest is settled first, by hashing the bytes that came back and
        comparing them to the hash the release stores. If they disagree, the walk
        stops there and the report says so: a document that has been altered is
        not an inventory worth trusting, and reporting assets "missing" on the
        strength of a tampered list would be worse than saying nothing.

        Otherwise every asset is checked the same way — read the blob, hash what
        was read, compare to the name it was stored under. ``exists`` is used only
        to tell a *missing* blob from a *corrupt* one, never as evidence of
        anything: a content-addressed store does not verify itself, because
        nothing stops a file being rewritten under a name that no longer
        describes it. That is exactly the fault this method is here to find.

        The row's cached ``schema_version`` and counts are checked against the
        document too. Anything reported there is a bug in this build rather than
        damage to the workspace, which is why those read as sentences.

        Raises:
            ReleaseNotFound: no such release in this workspace.
            WorkspaceCorrupt: the manifest blob is gone entirely.
        """
        release = self.get(release_id)
        blobs = self._workspace.blob_store
        stored = _read_blob(blobs, release.manifest_hash, _manifest_subject(release))
        if sha256_hex(stored) != release.manifest_hash:
            return ReleaseVerification(
                release_id=release.id,
                manifest_hash=release.manifest_hash,
                manifest_intact=False,
            )

        manifest = _parse_manifest(stored, _manifest_subject(release))
        missing: list[str] = []
        corrupt: list[str] = []
        for asset in manifest.assets:
            if not blobs.exists(asset.content_hash):
                missing.append(asset.content_hash)
                continue
            bytes_now = _read_blob(blobs, asset.content_hash, _asset_subject(asset))
            if sha256_hex(bytes_now) != asset.content_hash:
                corrupt.append(asset.content_hash)
        return ReleaseVerification(
            release_id=release.id,
            manifest_hash=release.manifest_hash,
            manifest_intact=True,
            checked=len(manifest.assets),
            missing=tuple(missing),
            corrupt=tuple(corrupt),
            cache_mismatches=_cache_mismatches(release, manifest),
        )

    def assignment(self, release_id: UUID) -> SplitAssignment:
        """Materialize this release's split recipe over its frozen asset set.

        Computed from the manifest, never from the dataset as it stands today.
        Reading live membership here would let a curator change a published
        release's folds by editing the trunk afterwards — the one thing a release
        exists to make impossible.

        Deterministic, so calling this twice, or on two releases of the same
        assets under the same seed, gives the same answer. Nothing is stored:
        there is no state here to fall out of step with the recipe.

        Raises:
            ReleaseNotFound: no such release in this workspace.
            NoSplitRecipe: the release was published without one.
            WorkspaceCorrupt: the manifest blob is gone, or is not a manifest.
        """
        release = self.get(release_id)
        if release.split is None:
            raise NoSplitRecipe(
                f"release {release.tag!r} was published without a split recipe, so it is one "
                f"undivided set; publish another release with a recipe to cut it"
            )
        return assign_split(release.split, self._read_manifest(release).assets)

    # --- handing the snapshot to a format plugin ---------------------------

    def check_export(
        self,
        release_id: UUID,
        exporter: Exporter,
        *,
        target: ExportTarget | None = None,
        recipe: RecipeSpec | None = None,
        drivers: Mapping[str, PreprocessingDriver] | None = None,
    ) -> ExportCompatibility:
        """What this format would drop from this release, before anything is written.

        ``target`` narrows the question to one trainer: a geometry the format
        writes but the target has no task for is reported dropped, and the
        report names the target it answers for. Without one the format alone
        is judged.

        ``recipe`` is checked here too, as :meth:`export` will check it: the
        geometry transform runs over what the export would hand the plugin, so
        a step that cannot move a label this release carries, or augmentation
        against a release with no split, refuses now rather than in a worker.
        A resize that crops — ``fill`` or ``center_crop`` — is the one step
        that loses labels, and its losses are in the report beside the
        format's: a label cut away is dropped, a label cut down is degraded,
        and either asks for consent the way a format's loss does. Whether
        each step can serve what the export carries is
        :meth:`recipe_compatibility`'s resolution, the one :meth:`export`
        refuses by; ``drivers``, when given, adds whether one is installed for
        every step.

        Computed from the **frozen manifest**, never from live membership: an
        export describes a release, and a release is a snapshot. Two runs against
        one release therefore agree forever, which is what lets one document be
        shown in a consent dialog, attached to a refusal and written into the
        output — three chances for them to disagree if it were derived from
        anything that moves.

        Every class the manifest declares appears, including ones nobody used.
        That is the report's most useful property and the least obvious: a class
        with **zero annotations excludes nothing**, however unsupported its
        geometry, so a schema declaring `mask` does not make every export of it
        lossy. The row is still there, with its zero, because "this format cannot
        write masks and you have none" is the answer somebody is looking for.

        `excluded_annotations` is the count somebody weighs; `excluded_assets` is
        how *wide* the loss is — the number of assets that would arrive carrying
        at least one label fewer than the release holds. An asset losing one box
        of forty and an asset losing its only one both count once, which is why
        the two numbers are published together rather than one being derived.

        Raises:
            ReleaseNotFound: no such release in this workspace.
            AugmentationRequiresSplit: the recipe augments and the release was
                published without a split recipe.
            PreprocessingStepUnsupportedGeometry: a recipe step cannot
                transform a geometry the export would carry.
            AugmentationIncompatible: ``target`` trains a label the export
                would carry for a task a recipe step does not serve.
            PreprocessingDriverNotFound: ``drivers`` was given and none of
                them applies a step the recipe holds.
            ExportSourceUnreadable: a recipe step needs a source size the
                manifest never recorded, or a recipe was given for an export
                that writes scans.
            WorkspaceCorrupt: the manifest blob is gone, or is not a manifest.
        """
        release = self.get(release_id)
        manifest = self._read_manifest(release)
        compatibility = _compatibility(release, manifest, exporter, target)
        if recipe is not None:
            view = _transformed(
                manifest, exporter, target, recipe, _split_of(release, manifest), drivers
            )
            compatibility = _compatibility(
                release, manifest, exporter, target, cropping=_cropping_of(recipe, view)
            )
        return compatibility

    def recipe_compatibility(
        self,
        release_id: UUID,
        exporter: Exporter,
        recipe: RecipeSpec,
        *,
        target: ExportTarget | None = None,
        drivers: Mapping[str, PreprocessingDriver] | None = None,
    ) -> AugmentationResolution:
        """Whether each step of ``recipe`` can serve each label this export would carry.

        The resolution :meth:`check_export` and :meth:`export` refuse by,
        computed the same way: over the frozen manifest narrowed to what the
        format and ``target`` carry, the release's own folds, the task set of
        ``target`` (none without one), and the step kinds ``drivers`` apply
        (unjudged without them). It refuses nothing itself; a ``conditional``
        entry is a loss the compatibility report counts and consent covers.

        Raises:
            ReleaseNotFound: no such release in this workspace.
            WorkspaceCorrupt: the manifest blob is gone, or is not a manifest.
        """
        release = self.get(release_id)
        manifest = self._read_manifest(release)
        return _resolved(
            _handed(manifest, exporter, target),
            recipe,
            _split_of(release, manifest),
            target,
            drivers,
        )

    def require_export_consent(
        self,
        release_id: UUID,
        exporter: Exporter,
        *,
        allow_lossy: bool,
        target: ExportTarget | None = None,
        recipe: RecipeSpec | None = None,
        drivers: Mapping[str, PreprocessingDriver] | None = None,
    ) -> ExportCompatibility:
        """The compatibility report, or refuse because the caller has not consented.

        **Public, and promoted out of :meth:`export` rather than copied**, because
        a second caller appeared: export now runs in a worker process, and a
        refusal discovered there can only be written on a job row somebody has to
        go and read. So the route asks this first, synchronously, and answers 409
        the way it always did — the "refusals split by *when they can be known*"
        rule ``IngestService.enqueue`` established.

        That makes the check run twice for one export, which is deliberate and is
        the shape this repository already uses for uniqueness: the pre-check is
        the error message and the one inside :meth:`export` is the guarantee. A
        worker that skipped it would depend on every future caller remembering.

        Consent is required if *either* half says so — a lossy format always asks,
        and a format declaring itself lossless still cannot silently drop a
        geometry it never claimed to write.

        The transform is pure and writes nothing, so it runs before consent is
        asked, and what a cropping resize cuts away is in the one report the
        refusal carries, beside the format's loss. A recipe the transform
        refuses outright still loses to an unconsented format loss: a caller
        who has not accepted the loss is answered about the loss first.

        Raises:
            ReleaseNotFound: no such release in this workspace.
            LossyExportNotConsented: the format, or a cropping resize in the
                recipe, drops information and the caller has not said that is
                acceptable.
            AugmentationRequiresSplit: the recipe augments and the release was
                published without a split recipe.
            PreprocessingStepUnsupportedGeometry: a recipe step cannot
                transform a geometry the export would carry.
            AugmentationIncompatible: ``target`` trains a label the export
                would carry for a task a recipe step does not serve.
            PreprocessingDriverNotFound: ``drivers`` was given and none of
                them applies a step the recipe holds.
            ExportSourceUnreadable: a recipe step needs a source size the
                manifest never recorded, or a recipe was given for an export
                that writes scans.
            WorkspaceCorrupt: the manifest blob is gone, or is not a manifest.
        """
        release = self.get(release_id)
        manifest = self._read_manifest(release)
        return _consented(release, manifest, exporter, allow_lossy, target, recipe, drivers)[0]

    def export(
        self,
        release_id: UUID,
        exporter: Exporter,
        dest: Path,
        *,
        allow_lossy: bool = False,
        allow_non_empty: bool = False,
        owned_by_workspace: bool = False,
        target: ExportTarget | None = None,
        recipe: RecipeSpec | None = None,
        recipe_name: str | None = None,
        drivers: Mapping[str, PreprocessingDriver] | None = None,
    ) -> ExportResult:
        """Write this release into ``dest`` in the exporter's format.

        ``target`` addresses the export to one trainer. The plugin is handed the
        manifest with every annotation the target has no task for removed, so
        the output holds exactly what the report says it holds: the port has no
        word for a target, and a drop the report promises must not depend on
        every plugin reading a declaration it cannot see.

        ``recipe`` is the pre-processing to apply, snapshotted by value; the
        stored recipe it came from, if any, is named by ``recipe_name`` for the
        report alone. The narrowing above happens **first** and the recipe runs
        over what is left, so a geometry the target drops can never make a
        step refuse. Folds come from the release's own split recipe over the
        frozen manifest — the same cut :meth:`assignment` answers — and
        augmented variants are generated for the train fold only. The plugin
        then sees one manifest asset per file to write: base images under
        their source hash, variants under ``<hash>-aug<k>``, and ``content``
        resolves either to the driver-transformed bytes. ``drivers`` are the
        installed :class:`PreprocessingDriver` instances keyed by step kind,
        composed by the caller because the kernel may not scan entry points.

        Takes an ``Exporter`` **instance**, never a format name, and that is the
        one place this service differs from every other read here. Plugins are
        discovered through an entry-point group that lives in
        ``visionset.formats``, which the kernel may not import — so resolving a
        name to an implementation belongs to whoever composed the call, and this
        method depends on the port the way every service depends on a port.

        ``allow_lossy`` is checked **before** anything is created, so a refused
        export leaves no half-written directory behind. It is a third word beside
        ``confirm=`` and ``allow_destructive=`` rather than a reuse of either:
        those guard destroying data and narrowing a contract, and this guards
        emitting an incomplete copy of something that stays exactly as it was.
        The check itself is :meth:`require_export_consent`, which is public
        because the REST surface asks it first — see that method for why running
        it twice is the point rather than the cost.

        The plugin runs outside any transaction. It is third-party code doing
        file I/O over what may be a very large manifest, and holding the
        workspace's single writer open across it is how a store starts reporting
        "database is locked" — the rule ``IngestService`` follows for a decode.

        Nothing here is recorded. An export produces no row, no event and no
        change-log entry: it reads a frozen artifact and writes outside the
        workspace's own files, so there is no state to keep in step. Re-running
        one is therefore free and always agrees with itself.

        ``dest`` must be absolute, neither inside the workspace nor containing
        it, and either missing or an empty directory; it is created if missing.
        A non-empty one is refused unless ``allow_non_empty``, and even then it
        is **not** emptied: deleting files under a path a caller named is not
        this service's to do, so the counts then describe the directory once the
        plugin has run rather than the run alone. ``owned_by_workspace`` is the
        server's export job and nobody else: its ``dest`` must instead lie under
        the workspace's ``exports/`` directory, which it clears itself.

        The recipe is checked first, then ``dest``, then every blob the export
        reads is hash-checked — all **before** ``dest`` is created, so a refused
        export writes nothing. An asset the format cannot open is not read, so
        its blob is not checked: an image export does not refuse over a scan.

        The plugin is handed the split assignment cut over the whole frozen
        manifest, the one :meth:`assignment` reports and the augmentation
        recipe generates train-fold variants from, so the folds it writes are
        the reported ones even when it is handed fewer assets than the release
        froze.

        Raises:
            ReleaseNotFound: no such release in this workspace.
            LossyExportNotConsented: the format, or a cropping resize in the
                recipe, drops information and the caller has not said that is
                acceptable.
            AugmentationRequiresSplit: the recipe augments and the release was
                published without a split recipe.
            PreprocessingStepUnsupportedGeometry: a recipe step cannot
                transform a geometry the export would carry.
            AugmentationIncompatible: ``target`` trains a label the export
                would carry for a task a recipe step does not serve.
            PreprocessingDriverNotFound: no driver in ``drivers`` applies a
                step the recipe holds.
            ExportSourceUnreadable: a recipe step needs a source size the
                manifest never recorded, a recipe was given for an export that
                writes scans, or a blob the release names is missing or does
                not match its hash.
            ExportDestinationRefused: ``dest`` is relative, inside or
                containing the workspace (outside its ``exports/`` when
                ``owned_by_workspace``), a file, or cannot be created or read.
            ExportDestinationNotEmpty: ``dest`` holds files and
                ``allow_non_empty`` is false.
            WorkspaceCorrupt: the manifest blob is gone, or is not a manifest.
        """
        release = self.get(release_id)
        manifest = self._read_manifest(release)
        compatibility, view = _consented(
            release,
            manifest,
            exporter,
            allow_lossy,
            target,
            recipe,
            {} if drivers is None else drivers,
        )
        addressed = _handed(manifest, exporter, target)
        assignment = _split_of(release, manifest)
        reader = _RecordingReader(manifest, self._workspace.blob_store)
        if recipe is None or view is None:
            handed = addressed
        else:
            handed = plugin_manifest(addressed, view)
            reader.transform(recipe, drivers or {})
        self._require_destination(
            dest, allow_non_empty=allow_non_empty, owned_by_workspace=owned_by_workspace
        )
        _require_intact_blobs(self._workspace.blob_store, addressed)
        try:
            dest.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ExportDestinationRefused(
                f"cannot create the export directory {dest}: {exc.strerror or exc}"
            ) from exc
        _hand_over(exporter, release, handed, dest, reader.read, assignment)
        # The report is **excluded from the count**, on both sides: it is not
        # written until after the walk, and a report left by an earlier run into
        # the same directory is skipped. Both halves are needed for the same
        # property — ``file_count`` describes what the *exporter* produced, so
        # an exporter writing nothing reports zero rather than one, and exporting
        # twice into one directory still agrees with itself.
        written = [
            path
            for path in dest.rglob("*")
            if path.is_file() and path.name != EXPORT_REPORT_FILENAME
        ]
        preprocessing = (
            None
            if recipe is None
            else ExportPreprocessing(
                recipe_name=recipe_name,
                spec=recipe,
                recipe_hash=recipe_hash(recipe),
                pillow_version=PILLOW_VERSION,
                mapping=reader.mapping(dest, written),
                dropped_annotations=0 if view is None else view.dropped_count,
                clipped_annotations=0 if view is None else view.clipped_count,
            )
        )
        _write_report(dest, compatibility, preprocessing)
        source_annotations, augmented_annotations = _annotation_counts(handed, view)
        return ExportResult(
            compatibility=compatibility,
            release_id=release.id,
            format_name=exporter.format_name,
            target=None if target is None else target.name,
            directory=dest,
            file_count=len(written),
            total_bytes=sum(path.stat().st_size for path in written),
            source_file_count=reader.read_count(variant=0),
            augmented_file_count=reader.read_count(variant=None) - reader.read_count(variant=0),
            source_annotation_count=source_annotations,
            augmented_annotation_count=augmented_annotations,
            preprocessing=preprocessing,
        )

    def _require_destination(
        self, dest: Path, *, allow_non_empty: bool, owned_by_workspace: bool
    ) -> None:
        # Compared by file identity, not by spelling: on a case-insensitive file
        # system ``<ws>/../WS/blobs`` names the workspace without matching it.
        if not dest.is_absolute():
            raise ExportDestinationRefused(
                f"the export directory must be an absolute path, and {dest} is not"
            )
        root = self._workspace.root
        exports = root / EXPORTS_DIRNAME
        try:
            if owned_by_workspace:
                exports.mkdir(exist_ok=True)
            resolved = dest.resolve()
            existing = next(one for one in (resolved, *resolved.parents) if one.exists())
            chain = (existing, *existing.parents)
            if owned_by_workspace:
                if not any(os.path.samefile(one, exports) for one in chain):
                    raise ExportDestinationRefused(
                        f"{dest} is not under the workspace's {EXPORTS_DIRNAME} directory"
                    )
            elif any(os.path.samefile(one, root) for one in chain):
                raise ExportDestinationRefused(
                    f"{dest} is inside the workspace; export somewhere outside it"
                )
            elif resolved.exists() and any(
                os.path.samefile(one, resolved) for one in root.resolve().parents
            ):
                raise ExportDestinationRefused(
                    f"{dest} contains the workspace; export somewhere outside it"
                )
            if resolved.exists() and not resolved.is_dir():
                raise ExportDestinationRefused(f"the export directory {dest} is a file")
            occupied = resolved.is_dir() and any(resolved.iterdir())
        except OSError as exc:
            raise ExportDestinationRefused(
                f"cannot read the export directory {dest}: {exc.strerror or exc}"
            ) from exc
        if occupied and not (allow_non_empty or owned_by_workspace):
            raise ExportDestinationNotEmpty(
                f"{dest} is not empty; choose an empty directory, or re-run with "
                f"allow_non_empty to write beside what is there"
            )

    # --- the blob store side ----------------------------------------------

    def _store_manifest(self, manifest: Manifest) -> str:
        """Write the canonical document and return the hash it landed under.

        The hash is ``put``'s answer rather than a second computation of the same
        thing, so the row cannot name a blob the store does not agree with.
        """
        return self._workspace.blob_store.put(BytesIO(canonical_bytes(manifest)))

    def open_manifest(self, release: Release) -> BinaryIO:
        """The document this release names, as raw bytes on an open handle.

        The unparsed sibling of :meth:`manifest`, and the difference is the whole
        point. A manifest is hash-pinned evidence: a caller forwarding it —
        writing it to a file, sending it over the wire — must send exactly what
        ``manifest_hash`` is the digest of, and a round trip through parse and
        re-serialize puts this build's JSON encoder between the two.

        Takes the release rather than an id because the caller reading a manifest
        is invariably one that already resolved it and wants the hash for an
        ``ETag`` beside the bytes.

        Raises:
            WorkspaceCorrupt: the manifest blob is gone.
        """
        try:
            return self._workspace.blob_store.get(release.manifest_hash)
        except FileNotFoundError as exc:
            raise WorkspaceCorrupt(
                f"{_manifest_subject(release)} is not in the blob store"
            ) from exc

    def member_asset_ids(self, dataset_id: UUID, release_id: UUID) -> frozenset[UUID]:
        """The asset ids a release of that dataset names.

        Raises:
            ReleaseNotFound: no such release, or it belongs to another dataset.
            WorkspaceCorrupt: the manifest blob is gone, or is not a manifest.
        """
        release = self.get(release_id)
        if release.dataset_id != dataset_id:
            raise ReleaseNotFound(f"dataset {dataset_id} has no release {release_id}")
        return frozenset(asset.asset_id for asset in self._read_manifest(release).assets)

    def tags_naming(
        self, dataset_id: UUID, asset_ids: Collection[UUID]
    ) -> dict[UUID, tuple[str, ...]]:
        """For each asset asked about, the tags of the releases that name it, oldest first.

        An asset no release names is absent from the answer. One manifest read per
        release of the dataset, never per asset, so the cost of a page is the
        number of releases rather than the size of the page.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
            WorkspaceCorrupt: a manifest blob is gone, or is not a manifest.
        """
        wanted = frozenset(asset_ids)
        tags: dict[UUID, list[str]] = {}
        if not wanted:
            return {}
        for release in self.list(dataset_id):
            for asset in self._read_manifest(release).assets:
                if asset.asset_id in wanted:
                    tags.setdefault(asset.asset_id, []).append(release.tag)
        return {asset_id: tuple(found) for asset_id, found in tags.items()}

    def _read_manifest(self, release: Release) -> Manifest:
        """The document this release names, parsed."""
        subject = _manifest_subject(release)
        raw = _read_blob(self._workspace.blob_store, release.manifest_hash, subject)
        return _parse_manifest(raw, subject)

    # --- lookups and refusals shared by the operations above ---------------

    def _require_release(self, uow: UnitOfWork, release_id: UUID) -> Release:
        """The release, and the dataset it hangs off, both checked.

        A release belonging to another workspace reads as missing rather than as
        forbidden, like every cross-scope reference here — and since a workspace
        is one file holding exactly one workspace row, an id from elsewhere is
        simply not stored.

        The dataset is resolved anyway, and not out of caution about that: it is
        what turns a release whose dataset row is *gone* into ``WorkspaceCorrupt``
        rather than a release that reads fine and cannot be explained. ``release``
        cascades from ``dataset``, so that is a guarantee failing — the reading a
        broken parent link gets.
        """
        release = uow.releases.get(release_id)
        if release is None:
            raise ReleaseNotFound(
                f"no release {release_id} in workspace {self._workspace.workspace.name!r}"
            )
        self._datasets.require_dataset(uow, release.dataset_id)
        return release

    def _require_tag_free(self, uow: UnitOfWork, dataset: Dataset, tag: str) -> None:
        """Refuse a tag this dataset has already used, before writing anything.

        Checked here as well as by the unique index, and comparing exactly what
        the index compares. A ``ConstraintViolated`` ends its transaction, so a
        service that only caught the index's refusal could not turn it into a
        sentence and carry on; this is what lets the ordinary case read well.
        """
        if any(release.tag == tag for release in uow.releases.list(dataset.id)):
            raise ReleaseTagTaken(
                f"dataset {dataset.name!r} already has a release tagged {tag!r}; a release is "
                f"never edited, so publish the correction under a new tag"
            )

    def _as_tag_collision(
        self, exc: ConstraintViolated, tag: str
    ) -> ReleaseTagTaken | ConstraintViolated:
        """Re-raise the tag index's complaint in the vocabulary callers expect.

        Two writers can both pass the pre-check and then race to insert; the loser
        is refused by the index, one layer below where the check ran. The
        violation ends its transaction, so this can only happen outside the
        ``with`` block — see ``ConstraintViolated``. Any other constraint is not
        this service's to reinterpret and travels on unchanged.
        """
        if _TAG_INDEX_MESSAGE in str(exc):
            return ReleaseTagTaken(f"another writer published {tag!r} first; choose another tag")
        return exc

    def list(self, dataset_id: UUID) -> list[Release]:
        """Every release of that dataset, oldest first.

        Last in the class on purpose: an annotation after a method named ``list``
        would resolve it to this method rather than to the builtin.

        Raises:
            DatasetNotFound: no such dataset in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            dataset = self._datasets.require_dataset(uow, dataset_id)
            return uow.releases.list(dataset.id)


def _require_intact_blobs(blobs: BlobStore, manifest: Manifest) -> None:
    """Refuse a release whose image blobs are missing or no longer match their hashes.

    A check before the copy, not of it: a blob rewritten between the two is not caught.
    """
    for asset in manifest.assets:
        try:
            with blobs.get(asset.content_hash) as stream:
                digest = sha256_hex_of_stream(stream)
        except FileNotFoundError as exc:
            raise ExportSourceUnreadable(
                f"{_asset_subject(asset)} is not in the blob store; "
                f"verify the release and restore it"
            ) from exc
        except OSError as exc:
            raise ExportSourceUnreadable(
                f"{_asset_subject(asset)} cannot be read: {exc.strerror or exc}"
            ) from exc
        if digest != asset.content_hash:
            raise ExportSourceUnreadable(
                f"{_asset_subject(asset)} no longer matches its content hash; "
                f"verify the release and restore it"
            )


def _manifest_assets(uow: UnitOfWork, assets: list[Asset]) -> tuple[ManifestAsset, ...]:
    """The frozen inventory: every asset in the trunk, with its labels copied in.

    One read per asset for its annotations, because the port has no cross-table
    query — ``Repository.list`` takes a single ``parent_id``, and an Annotation's
    parent is its Asset. That is N + 1 reads, and it is the same trade
    ``SchemaService`` makes for the same reason: when it starts to cost, the fix
    is a method on the port (``annotations.list_for_dataset``), never a SQLAlchemy
    import in a service.

    Nothing is sorted here. The canonical order is the manifest's own rule and
    the models apply it on construction, so this hands over the trunk's order and
    lets the artifact decide what it means — one place, not two that can drift.

    An asset carrying a 3D label gets a copy of the calibration that applies to
    it; every other asset gets none, whatever its source says, so a 2D release
    hashes as it did before calibration existed.

    A point-cloud asset carries its scan metadata and its source's declared
    frame instead, labelled or not, so the release says how to read every
    coordinate in the scan as well as on it.

    An asset's ``group_label`` is copied whatever ``split`` says, so a grouped
    recipe is cut from the document alone and the document stays a function of
    content.

    Raises:
        CalibrationMissing: an image with a 3D label has no calibration, or a
            scan has no source declaring its frame.
        CalibrationResolutionMismatch: its calibration was measured at another size.
    """
    built = []
    for asset in assets:
        annotations = uow.annotations.list(asset.id)
        source = None if asset.source_id is None else uow.sources.get(asset.source_id)
        calibration = None
        if any(
            geometry_needs_calibration(a.geometry, modality=asset.modality) for a in annotations
        ):
            calibration = require_calibration(asset, source)
        frame = None
        if asset.modality == "point_cloud" or any(
            geometry_needs_scan_frame(a.geometry, modality=asset.modality) for a in annotations
        ):
            frame = require_scan_frame(asset, source)
        built.append(
            ManifestAsset(
                asset_id=asset.id,
                content_hash=asset.content_hash,
                uri=asset.uri,
                width=asset.width,
                height=asset.height,
                annotations=tuple(_manifest_annotation(a) for a in annotations),
                calibration=calibration,
                modality=asset.modality,
                point_cloud=asset.point_cloud,
                frame=frame,
                group_label=asset.group_label,
            )
        )
    return tuple(built)


def _manifest_tracks(
    uow: UnitOfWork, assets: tuple[ManifestAsset, ...]
) -> tuple[ManifestTrack, ...]:
    """Every track observing an annotation the release copies, cut to those observations.

    Walked from the annotations, so an observation is listed only where the
    release holds both its asset and its annotation, and a track from any
    source an asset occurs in is found, not only the asset's first-seen one.

    Raises:
        WorkspaceCorrupt: an observation names a missing track, or an occurrence that
            is missing, decoded to another asset than its annotation's, or sits in
            another source than its track.
    """
    tracks: dict[UUID, Track] = {}
    observed: dict[UUID, list[ManifestObservation]] = {}
    for asset in assets:
        for annotation in asset.annotations:
            observation = uow.observation_of(annotation.id)
            if observation is None:
                continue
            occurrence = uow.frame_occurrences.get(observation.occurrence_id)
            track = tracks.get(observation.track_id) or uow.tracks.get(observation.track_id)
            if (
                occurrence is None
                or track is None
                or occurrence.asset_id != asset.asset_id
                or occurrence.source_id != track.source_id
            ):
                raise WorkspaceCorrupt(
                    f"annotation {annotation.id} on asset {asset.asset_id} is observed at "
                    f"occurrence {observation.occurrence_id} by track {observation.track_id}, "
                    f"which do not both exist, on that asset and in one source"
                )
            tracks[track.id] = track
            observed.setdefault(track.id, []).append(
                ManifestObservation(
                    position=occurrence.position,
                    timestamp=occurrence.timestamp,
                    asset_id=occurrence.asset_id,
                    annotation_id=annotation.id,
                )
            )
    return tuple(
        ManifestTrack(
            id=track.id,
            source_id=track.source_id,
            label_class=track.label_class,
            external_id=track.external_id,
            observations=tuple(observed[track.id]),
        )
        for track in tracks.values()
    )


def _manifest_sources(
    uow: UnitOfWork, project_id: UUID, assets: tuple[ManifestAsset, ...]
) -> tuple[ManifestSource, ...]:
    """Each imported sequence of the project, with the occurrences of released assets.

    A source none of whose occurrences the release holds is not listed.
    """
    held = {asset.asset_id for asset in assets}
    listed = []
    for source in uow.sources.list(project_id):
        if source.kind is SourceKind.IMAGE_SEQUENCE:
            kind: Literal["image_sequence", "point_cloud_sequence"] = "image_sequence"
        elif source.kind is SourceKind.POINT_CLOUD_SEQUENCE:
            kind = "point_cloud_sequence"
        else:
            continue
        occurrences = tuple(
            ManifestOccurrence(
                position=one.position, timestamp=one.timestamp, asset_id=one.asset_id
            )
            for one in uow.frame_occurrences.list(source.id)
            if one.asset_id in held
        )
        if occurrences:
            listed.append(ManifestSource(source_id=source.id, kind=kind, occurrences=occurrences))
    return tuple(listed)


def _release_schema_blockers(
    schema: AnnotationSchema, assets: tuple[ManifestAsset, ...]
) -> tuple[ClassCount, ...]:
    """Count candidate annotations that the active release schema would reject."""
    annotations: dict[str, int] = {}
    affected_assets: dict[str, set[UUID]] = {}
    for asset in assets:
        for annotation in asset.annotations:
            try:
                validate_schema_annotation(
                    label_class=annotation.label_class,
                    geometry=annotation.geometry,
                    attributes=annotation.attributes,
                    schema=schema,
                )
            except InvalidAnnotation:
                annotations[annotation.label_class] = annotations.get(annotation.label_class, 0) + 1
                affected_assets.setdefault(annotation.label_class, set()).add(asset.asset_id)
    return tuple(
        ClassCount(
            label_class=name,
            annotations=annotations[name],
            assets=len(affected_assets[name]),
        )
        for name in sorted(annotations)
    )


def _manifest_annotation(annotation: Annotation) -> ManifestAnnotation:
    """One live label, copied field by field into its frozen twin.

    Spelled out rather than converted wholesale: the two models are the same shape
    today except for ``asset_id``, which the manifest does not repeat because the
    label already sits under its asset — and being explicit is what makes adding a
    field to ``Annotation`` a decision about the artifact rather than a silent
    change to every manifest hash ever computed.
    """
    return ManifestAnnotation(
        id=annotation.id,
        label_class=annotation.label_class,
        schema_version=annotation.schema_version,
        geometry=annotation.geometry,
        attributes=dict(annotation.attributes),
        provenance=annotation.provenance,
        model_ref=annotation.model_ref,
        confidence=annotation.confidence,
    )


def _cache_mismatches(release: Release, manifest: Manifest) -> tuple[str, ...]:
    """Where the row's summary disagrees with the document it names.

    The row caches three facts so that listing releases does not open a blob per
    row. A cache nobody checks is a fact nobody can trust, so it is checked — and
    it reads as sentences because anything in here means this build wrote a row
    that does not describe its own manifest.
    """
    checks = (
        ("schema version", release.schema_version, manifest.schema_version),
        ("asset count", release.asset_count, len(manifest.assets)),
        ("annotation count", release.annotation_count, manifest.annotation_count),
    )
    return tuple(
        f"the release records {name} {stored}, but its manifest says {actual}"
        for name, stored, actual in checks
        if stored != actual
    )


def _split_of(release: Release, manifest: Manifest) -> SplitAssignment | None:
    """The release's split over its whole frozen manifest, the cut ``assignment`` answers."""
    return None if release.split is None else assign_split(release.split, manifest.assets)


_RECIPE_REFUSALS: Final = (
    AugmentationRequiresSplit,
    PreprocessingStepUnsupportedGeometry,
    AugmentationIncompatible,
    PreprocessingDriverNotFound,
    ExportSourceUnreadable,
)


def _consented(
    release: Release,
    manifest: Manifest,
    exporter: Exporter,
    allow_lossy: bool,
    target: ExportTarget | None,
    recipe: RecipeSpec | None,
    drivers: Mapping[str, PreprocessingDriver] | None,
) -> tuple[ExportCompatibility, TransformedView | None]:
    """The report, and the recipe's view, or refuse an export nobody consented to.

    The transform is pure, so it runs first and the one consent question is
    asked over everything the export would lose — the format's and a cropping
    resize's together — so the report a refusal carries is the report the
    export writes. A recipe the transform refuses outright is answered after
    consent, as before: a caller who has not accepted the format's loss hears
    about that first. Nothing is written either way.
    """
    compatibility = _compatibility(release, manifest, exporter, target)
    if recipe is None:
        _require_consent(release, exporter, compatibility, allow_lossy)
        return compatibility, None
    try:
        view = _transformed(
            manifest, exporter, target, recipe, _split_of(release, manifest), drivers
        )
    except _RECIPE_REFUSALS:
        _require_consent(release, exporter, compatibility, allow_lossy)
        raise
    cropping = _cropping_of(recipe, view)
    if cropping is not None:
        compatibility = _compatibility(release, manifest, exporter, target, cropping=cropping)
    _require_consent(release, exporter, compatibility, allow_lossy, cropping)
    return compatibility, view


def _require_consent(
    release: Release,
    exporter: Exporter,
    compatibility: ExportCompatibility,
    allow_lossy: bool,
    cropping: _Cropping | None = None,
) -> None:
    if (exporter.lossy or not compatibility.compatible) and not allow_lossy:
        subject = f"format {exporter.format_name!r}"
        if cropping is not None:
            subject = f"{subject} after a {cropping.strategy} resize"
        raise LossyExportNotConsented(
            f"{subject} cannot carry everything release "
            f"{release.tag!r} holds ({_loss_reason(compatibility)}); "
            "re-run with allow_lossy to accept the loss",
            compatibility=compatibility,
        )


@dataclass(frozen=True)
class _Cropping:
    """What a cropping resize did to the release's own labels, by annotation id."""

    strategy: ResizeStrategy
    dropped: frozenset[UUID]
    clipped: frozenset[UUID]


def _cropping_of(recipe: RecipeSpec, view: TransformedView) -> _Cropping | None:
    """The base images' crop losses, or ``None`` when the recipe crops nothing.

    Read from the base images alone: the resize runs before every
    augmentation and identically for every variant, so a variant loses
    exactly the labels its base image does.
    """
    resize = next((step for step in recipe.steps if isinstance(step, ResizeStep)), None)
    if resize is None or resize.strategy not in CROPPING_STRATEGIES:
        return None
    base = [file for file in view.files if file.variant == 0]
    return _Cropping(
        strategy=resize.strategy,
        dropped=frozenset(one for file in base for one in file.dropped),
        clipped=frozenset(one for file in base for one in file.clipped),
    )


def _transformed(
    manifest: Manifest,
    exporter: Exporter,
    target: ExportTarget | None,
    recipe: RecipeSpec,
    assignment: SplitAssignment | None,
    drivers: Mapping[str, PreprocessingDriver] | None,
) -> TransformedView:
    """What the recipe makes of the manifest an export would hand the plugin.

    Narrowed by :func:`_handed` first, so a geometry the export drops never
    reaches a step that cannot move it; folds from :func:`_split_of`. A recipe
    reads and writes images, so an export handing the plugin a scan refuses one.
    The recipe is then resolved over what is left and refused by
    :func:`_refuse_unresolved` before anything is transformed.

    Raises:
        ExportSourceUnreadable: the export would hand the plugin a point-cloud
            asset, which records no pixel size and is not an image.
        AugmentationRequiresSplit, PreprocessingStepUnsupportedGeometry,
            AugmentationIncompatible, PreprocessingDriverNotFound,
            ExportSourceUnreadable: from :func:`_refuse_unresolved` and
            ``transform_manifest``.
    """
    handed = _handed(manifest, exporter, target)
    scan = next((asset for asset in handed.assets if asset.modality != "image"), None)
    if scan is not None:
        raise ExportSourceUnreadable(
            f"asset {scan.asset_id} is a {scan.modality}, and a pre-processing recipe "
            f"transforms images only; export to {exporter.format_name} without a recipe"
        )
    resolution = _resolved(handed, recipe, assignment, target, drivers)
    _refuse_unresolved(resolution, handed, recipe, assignment, drivers)
    return transform_manifest(handed, recipe, assignment)


def _resolved(
    handed: Manifest,
    recipe: RecipeSpec,
    assignment: SplitAssignment | None,
    target: ExportTarget | None,
    drivers: Mapping[str, PreprocessingDriver] | None,
) -> AugmentationResolution:
    """The recipe's resolution over the manifest an export hands its plugin.

    The one spelling :meth:`ReleaseService.recipe_compatibility`, pre-flight
    and export share, so the three cannot disagree about what is refused.
    """
    return resolve_augmentation(
        recipe,
        carried_by(handed, assignment),
        target_tasks=None if target is None else target.tasks,
        installed_step_kinds=None if drivers is None else frozenset(drivers),
    )


def _refuse_unresolved(
    resolution: AugmentationResolution,
    handed: Manifest,
    recipe: RecipeSpec,
    assignment: SplitAssignment | None,
    drivers: Mapping[str, PreprocessingDriver] | None,
) -> None:
    """Refuse a recipe the resolution refuses, with the refusal each reason has always had.

    Answered in the order an export always met them: ``transform_manifest``
    first, so a missing split, a geometry a step cannot move or a source size
    the manifest never recorded keeps its class, message and first offender;
    then a missing driver, as ``driver_for`` words it; then every other reason
    as :class:`AugmentationIncompatible`, which never names a missing driver.
    A resolution that refuses and is answered by none of these is still
    refused: unknown support is never assumed.

    Raises:
        AugmentationRequiresSplit, PreprocessingStepUnsupportedGeometry,
            ExportSourceUnreadable: from ``transform_manifest``.
        PreprocessingDriverNotFound: a step's kind has no installed driver,
            or the registry declares none for its operation.
        AugmentationIncompatible: any other refusal.
    """
    refused = resolution.refusals()
    if not refused:
        return
    transform_manifest(handed, recipe, assignment)
    if ReasonCode.DRIVER_UNAVAILABLE in resolution.reasons():
        if drivers is not None:
            for step in recipe.steps:
                driver_for(drivers, step.kind)
        undriven = next(one for one in refused if ReasonCode.DRIVER_UNAVAILABLE in one.reasons)
        raise PreprocessingDriverNotFound(undriven.message, installed=tuple(sorted(drivers or {})))
    raise incompatible(refused)


def _hand_over(
    exporter: Exporter,
    release: Release,
    manifest: Manifest,
    dest: Path,
    content: ContentReader,
    assignment: SplitAssignment | None,
) -> None:
    """Call the plugin, with ``assignment`` when its ``export`` takes the keyword."""
    if _accepts_assignment(exporter):
        exporter.export(release, manifest, dest, content=content, assignment=assignment)
    else:
        legacy: Callable[..., None] = exporter.export
        legacy(release, manifest, dest, content=content)


def _accepts_assignment(exporter: Exporter) -> bool:
    try:
        parameters = inspect.signature(exporter.export).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(
        parameter.name == "assignment" or parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in parameters
    )


def transformed_bytes(
    spec: RecipeSpec,
    drivers: Mapping[str, PreprocessingDriver],
    source: bytes,
    *,
    content_hash: str,
    variant: int,
    showcase: bool = False,
) -> bytes:
    """One image through the recipe's steps, for one variant.

    The resize step runs for every variant; augmentation steps run for
    variants ``1..n`` only, each applying its draw from the variant's
    :func:`sample_plan` — the plan ``transform_manifest`` moved the labels by,
    so the pixels land where the labels are. Shared by the export seam and the
    preview, which is what makes a preview show what an export will write.
    ``showcase`` samples the plan from ``SHOWCASE_SEED`` instead, the preview's
    way of showing each step at its declared strength; an export never sets it.

    Raises:
        PreprocessingDriverNotFound: no driver in ``drivers`` applies a step.
    """
    spec_hash = recipe_hash(spec)
    seed = SHOWCASE_SEED if showcase else variant_seed(spec_hash, content_hash, variant)
    plan = (
        sample_plan(
            spec,
            content_hash=content_hash,
            variant=variant,
            showcase=showcase,
            spec_hash=spec_hash,
        )
        if variant > 0
        else None
    )
    image = source
    for step in spec.steps:
        if isinstance(step, ResizeStep):
            image = driver_for(drivers, step.kind).apply(step, image, seed=seed, variant=variant)
        elif plan is not None:
            driver = driver_for(drivers, step.kind)
            if accepts_draw(driver):
                draw = plan.draw_for(step)
                image = driver.apply(step, image, seed=seed, variant=variant, draw=draw)
            else:
                image = driver.apply(step, image, seed=seed, variant=variant)
    return image


@dataclass(frozen=True)
class _Produced:
    """What one read through the content reader handed the plugin."""

    source_content_hash: str
    variant: int
    exported_sha256: str | None


class _RecordingReader:
    """The reader a plugin lays images out with, composed for exactly one export.

    Closed over the manifest so the refusal can name the *asset* rather than the
    hash a plugin happened to ask for — a caller who never saw a content hash
    cannot act on one. Built here rather than handing the blob store over
    because a format plugin has no business writing into the content store; see
    :data:`~visionset.kernel.ports.ContentReader`.

    Without a recipe the handle is the blob store's own and is **not** closed
    here: a plugin streaming a large image into a file wants the stream. Under
    a recipe every key resolves through :func:`transformed_bytes` — a base
    image under its source hash, a variant under ``<hash>-aug<k>`` — and the
    bytes are held in memory, because a driver returns bytes.

    Every read is recorded, so the result can count the images the plugin took
    and, under a recipe, trace each written file to its source.
    """

    def __init__(self, manifest: Manifest, blobs: BlobStore) -> None:
        self._subjects = {asset.content_hash: _asset_subject(asset) for asset in manifest.assets}
        self._blobs = blobs
        self._spec: RecipeSpec | None = None
        self._drivers: Mapping[str, PreprocessingDriver] = {}
        self._produced: dict[str, _Produced] = {}

    def transform(self, spec: RecipeSpec, drivers: Mapping[str, PreprocessingDriver]) -> None:
        self._spec = spec
        self._drivers = drivers

    def read(self, key: str) -> BinaryIO:
        source_hash, variant = source_of_content_hash(key)
        if self._spec is None:
            self._produced[key] = _Produced(source_hash, variant, None)
            return self._open(source_hash)
        with self._open(source_hash) as stream:
            source = stream.read()
        image = transformed_bytes(
            self._spec, self._drivers, source, content_hash=source_hash, variant=variant
        )
        self._produced[key] = _Produced(source_hash, variant, sha256_hex(image))
        return BytesIO(image)

    def _open(self, content_hash: str) -> BinaryIO:
        try:
            return self._blobs.get(content_hash)
        except FileNotFoundError as exc:
            named = self._subjects.get(content_hash, f"content {content_hash}")
            raise ExportSourceUnreadable(
                f"{named} is not in the blob store; verify the release and restore it"
            ) from exc

    def read_count(self, *, variant: int | None) -> int:
        """How many distinct keys were read: all of them, or one variant's."""
        return sum(
            1 for one in self._produced.values() if variant is None or one.variant == variant
        )

    def mapping(self, dest: Path, written: list[Path]) -> tuple[ExportFileMapping, ...]:
        """Each read traced to the file it landed in, by name and then by digest.

        Every built-in format names an image after the key it read it under,
        so the stem is the first match; a plugin naming files its own way is
        found by hashing what it wrote. A read no file matches — a plugin
        that read and did not write — is left out rather than guessed.
        """
        rows: dict[str, ExportFileMapping] = {}
        by_stem: dict[str, list[Path]] = {}
        for path in written:
            by_stem.setdefault(path.stem, []).append(path)
        claimed: set[Path] = set()
        unmatched: dict[str, _Produced] = {}
        for key, produced in self._produced.items():
            if produced.exported_sha256 is None:
                continue
            # A label file shares the image's stem, so the stem alone is
            # ambiguous; the digest says which sibling holds the pixels.
            match = next(
                (
                    candidate
                    for candidate in by_stem.get(key, ())
                    if sha256_hex(candidate.read_bytes()) == produced.exported_sha256
                ),
                None,
            )
            if match is not None:
                rows[key] = _mapping_row(dest, match, produced)
                claimed.add(match)
            else:
                unmatched[produced.exported_sha256] = produced
        if unmatched:
            for path in written:
                if path in claimed:
                    continue
                digest = sha256_hex(path.read_bytes())
                if digest in unmatched:
                    produced = unmatched.pop(digest)
                    rows[_key_of(produced)] = _mapping_row(dest, path, produced)
        return tuple(rows[key] for key in sorted(rows))


def _key_of(produced: _Produced) -> str:
    return (
        produced.source_content_hash
        if produced.variant == 0
        else f"{produced.source_content_hash}-aug{produced.variant}"
    )


def _mapping_row(dest: Path, path: Path, produced: _Produced) -> ExportFileMapping:
    assert produced.exported_sha256 is not None
    return ExportFileMapping(
        file=path.relative_to(dest).as_posix(),
        source_content_hash=produced.source_content_hash,
        exported_sha256=produced.exported_sha256,
        variant=produced.variant,
    )


def _annotation_counts(handed: Manifest, view: TransformedView | None) -> tuple[int, int]:
    """Labels handed to the plugin, split into the release's own and the augmented."""
    if view is None:
        return handed.annotation_count, 0
    source = sum(len(file.annotations) for file in view.files if file.variant == 0)
    return source, sum(len(file.annotations) for file in view.files if file.variant > 0)


def _read_blob(blobs: BlobStore, content_hash: str, subject: str) -> bytes:
    """The bytes under that hash, or say what is missing in domain words.

    ``BlobStore.get`` raises the stdlib ``FileNotFoundError``, which must not
    reach a caller of the kernel. The handle is closed here rather than by the
    caller: a release of ten thousand assets would be ten thousand open files
    otherwise.
    """
    try:
        with blobs.get(content_hash) as stream:
            return stream.read()
    except FileNotFoundError as exc:
        raise WorkspaceCorrupt(f"{subject} is not in the blob store") from exc


def _parse_manifest(raw: bytes, subject: str) -> Manifest:
    """Read a manifest out of its own bytes, or report the workspace broken.

    Both failures are the same fault wearing different coats: the blob is not
    JSON, or it is JSON that is not a manifest — including a manifest written in
    a format this build does not read, which ``extra='forbid'`` refuses on
    purpose. Either way a release names something the workspace was supposed to
    keep intact and did not, which is corruption rather than a missing entity —
    the reading a broken parent link gets. Letting a
    ``JSONDecodeError`` or a pydantic ``ValidationError`` out would also break
    the rule that no exception from outside the kernel's vocabulary escapes it.
    """
    try:
        return Manifest.model_validate(json.loads(raw))
    except (ValidationError, ValueError) as exc:
        raise WorkspaceCorrupt(f"{subject} is not a readable manifest: {exc}") from exc


def _manifest_subject(release: Release) -> str:
    return f"the manifest of release {release.tag!r} ({release.manifest_hash})"


def _asset_subject(asset: ManifestAsset) -> str:
    return f"asset {asset.asset_id} ({asset.content_hash})"


#: Where the report lands inside an export directory.
#:
#: A fixed name at the root, because the report is *attached to the export
#: output* and the output is a directory a format lays out however it likes.
#: A dotfile would be invisible to the archive a caller downloads, and a
#: name derived from the format would be one more thing two exporters could
#: spell differently.
EXPORT_REPORT_FILENAME: Final = "visionset-export-report.json"


def _write_report(
    dest: Path, compatibility: ExportCompatibility, preprocessing: ExportPreprocessing | None
) -> None:
    """Put the report in the output, after the plugin has written its own files.

    After, and not before: a plugin that clears its own subdirectory would
    otherwise take it with it, and this is the one file the *kernel* promises is
    there. It is also why the name is at the root rather than beside anything a
    format arranges.

    ``sort_keys`` for the reason ``canonical_bytes`` uses it: two exports of one
    release must produce identical bytes, and a dict's iteration order is not
    something to leave to chance in a file somebody will diff.

    ``preprocessing`` is one more key beside the compatibility document —
    ``null`` for an export that applied no recipe, so the key is always there
    to read.
    """
    dest.joinpath(EXPORT_REPORT_FILENAME).write_text(
        json.dumps(
            {
                # ``by_alias`` is the whole point: this file has to be key-for-key
                # the document ``wire.export_compatibility`` and
                # ``ExportCompatibilityOut`` publish. The report format is stable
                # across all three surfaces, and the artifact is one of them.
                **compatibility.model_dump(mode="json", by_alias=True),
                "preprocessing": None
                if preprocessing is None
                else preprocessing.model_dump(mode="json"),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def _compatibility(
    release: Release,
    manifest: Manifest,
    exporter: Exporter,
    target: ExportTarget | None = None,
    *,
    cropping: _Cropping | None = None,
) -> ExportCompatibility:
    """Judge one manifest against one format's declared capabilities.

    Pure, and takes the manifest rather than reading one, so the two callers —
    :meth:`ReleaseService.check_export` and :meth:`ReleaseService.export` —
    cannot disagree about what a release contains.

    **Three outcomes, not two.** Each class *and geometry* is written whole,
    written reduced, or not written, read off the format's two declared geometry
    sets. With only a boolean, this would count a converted polygon as an absent
    one while the YOLO and VOC exporters wrote it as a box — the report and the
    output disagreeing about the same annotations, neither wrong on its own terms.
    Per geometry rather than per class for the same kind of reason: a class
    accepting both boxes and polygons has two answers under a boxes-only format,
    and a row that carried one of them would misdescribe the other.
    ``excluded_annotations`` counts what disappears and
    ``degraded_annotations`` counts what survives coarser; ``compatible`` is false
    for either, so nothing about consent moved.

    **Modality first, from the snapshot.** A :class:`ManifestAsset` records
    its modality (manifest version 5), and an asset whose modality the format
    does not declare in ``supported_modalities`` is absent from the output
    whole: it is counted in ``dropped_modalities`` and in the excluded totals,
    and its labels are left out of the per-class rows, which judge only what
    reaches the format. Never read off the live ``Asset``, so the report stays
    a function of the release alone.

    **A target narrows the format.** Given one, a geometry the format writes
    whole but the target's task set does not accept is reported dropped, and
    consent for it rides on ``allow_lossy`` like every other loss. A geometry
    no annotation can carry today is never a row, with or without a target:
    a target listing pose is describing a trainer, not a loss.

    **A solitary geometry is dropped when it has company.** An exporter may
    declare ``solitary_geometries`` — written only when the export carries no
    other geometry, the way a YOLO dialect writes tags as a class tree but has
    no place for one beside a box. When anything else reaches the output, those
    rows are reported dropped, because that is what the plugin does.

    **A cropping resize loses labels one by one.** Given ``cropping``, a label
    the crop cut away counts as dropped and one it cut down as degraded,
    unless the format already loses it more. Those labels leave their
    ``(class, geometry)`` row for rows of their own — one ``dropped``, one
    ``degraded`` — naming the crop in ``cropped_by``, so every row's count is
    the labels that meet its status and no more. A label the crop cut away
    is not company for a solitary geometry: the plugin never sees it.

    **A tracked-only format drops what no track observes.** An exporter may
    declare ``tracked_only``, the way a MOT sequence writes a box only as an
    observation of a track. A label it would otherwise write that no released
    track observes leaves its row for a ``dropped`` row of its own, unless the
    crop already drops it.

    **A single-tag format keeps one tag per asset.** An exporter may declare
    ``single_tag``, the way a class-directory tree files each picture under one
    class. The tags :func:`single_tag` does not keep leave their row for a
    ``dropped`` row of their own, and an asset with no tag to keep is counted
    in ``untagged_assets``: it is not written at all.
    """
    writes = supported_modalities_of(exporter)
    unopenable = [asset for asset in manifest.assets if asset.modality not in writes]
    dropped_modalities = tuple(
        ModalityCompatibility(
            modality=modality,
            assets=len(of_modality),
            annotations=sum(len(asset.annotations) for asset in of_modality),
            reason=(
                f"{exporter.format_name} does not write {modality} assets, so "
                f"{len(of_modality)} of them are left out with every label on them"
            ),
        )
        for modality in sorted({asset.modality for asset in unopenable})
        for of_modality in [[asset for asset in unopenable if asset.modality == modality]]
    )
    manifest = _openable(manifest, exporter)

    # Keyed by class *and* geometry: a class accepting both boxes and polygons
    # gets one row per shape, because a boxes-only format writes one whole and
    # reduces the other and a single row could only say one of those. Seeded from
    # the declared classes so a class nobody used still appears, at zero.
    per_shape: dict[tuple[str, GeometryType], tuple[int, set[UUID]]] = {}
    cut: dict[tuple[str, GeometryType, ClassExportStatus], tuple[int, set[UUID]]] = {}
    for declared in manifest.classes:
        for geometry in declared.geometries:
            if geometry in IMPLEMENTED_GEOMETRIES:
                per_shape[(declared.name, geometry)] = (0, set())

    untracked = _untracked(manifest, exporter)
    untracked_rows: dict[tuple[str, GeometryType], tuple[int, set[UUID]]] = {}
    surplus, untagged_assets = _single_tagged(manifest, exporter, target)
    surplus_rows: dict[tuple[str, GeometryType], tuple[int, set[UUID]]] = {}
    solitary: frozenset[GeometryType] = getattr(exporter, "solitary_geometries", frozenset())
    crowded = any(
        GeometryType(annotation.geometry.type) not in solitary
        and _status_of(GeometryType(annotation.geometry.type), exporter, target)
        is not ClassExportStatus.DROPPED
        and _crop_status(cropping, annotation.id) is not ClassExportStatus.DROPPED
        and annotation.id not in untracked
        and annotation.id not in surplus
        for asset in manifest.assets
        for annotation in asset.annotations
    )

    def status_of(geometry: GeometryType) -> ClassExportStatus:
        if crowded and geometry in solitary:
            return ClassExportStatus.DROPPED
        return _status_of(geometry, exporter, target)

    def reason_for(geometry: GeometryType) -> str | None:
        status = status_of(geometry)
        if crowded and geometry in solitary and status is ClassExportStatus.DROPPED:
            return (
                f"{exporter.format_name} writes a {geometry.value} only when the export "
                f"holds nothing else, so it drops it here"
            )
        return _reason_for(status, geometry, exporter, target)

    counts = {status: 0 for status in ClassExportStatus}
    touched: dict[ClassExportStatus, set[UUID]] = {status: set() for status in ClassExportStatus}
    for asset in manifest.assets:
        for annotation in asset.annotations:
            geometry = GeometryType(annotation.geometry.type)
            # Publication rejects new inconsistent manifests, but this report also
            # reads archived or externally supplied manifests. Dropping an
            # undeclared label here would make the report silently wrong.
            status = status_of(geometry)
            crop = _crop_status(cropping, annotation.id)
            if annotation.id in surplus and status is not ClassExportStatus.DROPPED:
                status = ClassExportStatus.DROPPED
                key = (annotation.label_class, geometry)
                count, assets = surplus_rows.get(key, (0, set()))
                surplus_rows[key] = (count + 1, assets | {asset.asset_id})
                per_shape.setdefault(key, (0, set()))
            elif (
                annotation.id in untracked
                and status is not ClassExportStatus.DROPPED
                and crop is not ClassExportStatus.DROPPED
            ):
                status = ClassExportStatus.DROPPED
                key = (annotation.label_class, geometry)
                count, assets = untracked_rows.get(key, (0, set()))
                untracked_rows[key] = (count + 1, assets | {asset.asset_id})
                per_shape.setdefault(key, (0, set()))
            elif crop is not None and _LOSS_ORDER[crop] > _LOSS_ORDER[status]:
                status = crop
                cut_key = (annotation.label_class, geometry, crop)
                count, assets = cut.get(cut_key, (0, set()))
                cut[cut_key] = (count + 1, assets | {asset.asset_id})
                per_shape.setdefault((annotation.label_class, geometry), (0, set()))
            else:
                count, assets = per_shape.get((annotation.label_class, geometry), (0, set()))
                per_shape[(annotation.label_class, geometry)] = (
                    count + 1,
                    assets | {asset.asset_id},
                )
            counts[status] += 1
            touched[status].add(asset.asset_id)

    left_out: dict[tuple[str, GeometryType], int] = {}
    for asset in unopenable:
        for annotation in asset.annotations:
            key = (annotation.label_class, GeometryType(annotation.geometry.type))
            left_out[key] = left_out.get(key, 0) + 1

    def row_reason(name: str, geometry: GeometryType, count: int) -> str | None:
        reason = reason_for(geometry)
        elsewhere = left_out.get((name, geometry), 0)
        if reason is None or count or not elsewhere:
            return reason
        return (
            f"{reason}; none reach it here, because its {elsewhere} label(s) are on assets "
            f"{exporter.format_name} does not write, counted under dropped_modalities"
        )

    classes: list[ClassCompatibility] = []
    for (name, geometry), (count, assets) in per_shape.items():
        crop_rows = [
            ClassCompatibility(
                label_class=name,
                geometry=geometry,
                status=crop,
                annotations=cut_count,
                assets=len(cut_assets),
                reason=_crop_reason(cropping, crop, cut_count),
                cropped_by=None if cropping is None else cropping.strategy,
            )
            for crop in (ClassExportStatus.DEGRADED, ClassExportStatus.DROPPED)
            for cut_count, cut_assets in [cut.get((name, geometry, crop), (0, set()))]
            if cut_count
        ]
        dropped_count, dropped_assets = untracked_rows.get((name, geometry), (0, set()))
        if dropped_count:
            crop_rows.insert(
                0,
                ClassCompatibility(
                    label_class=name,
                    geometry=geometry,
                    status=ClassExportStatus.DROPPED,
                    annotations=dropped_count,
                    assets=len(dropped_assets),
                    reason=(
                        f"{exporter.format_name} writes a label only where a track observes "
                        f"it, and drops it here: no track observes these {dropped_count}"
                    ),
                ),
            )
        surplus_count, surplus_assets = surplus_rows.get((name, geometry), (0, set()))
        if surplus_count:
            crop_rows.insert(
                0,
                ClassCompatibility(
                    label_class=name,
                    geometry=geometry,
                    status=ClassExportStatus.DROPPED,
                    annotations=surplus_count,
                    assets=len(surplus_assets),
                    reason=(
                        f"{exporter.format_name} files a picture under one class, the first "
                        f"of its tags by name, and drops these {surplus_count} beside it"
                    ),
                ),
            )
        if count or not crop_rows:
            classes.append(
                ClassCompatibility(
                    label_class=name,
                    geometry=geometry,
                    status=status_of(geometry),
                    annotations=count,
                    assets=len(assets),
                    reason=row_reason(name, geometry, count),
                )
            )
        classes.extend(crop_rows)

    dropped = counts[ClassExportStatus.DROPPED] + sum(row.annotations for row in dropped_modalities)
    touched[ClassExportStatus.DROPPED] |= {asset.asset_id for asset in unopenable}
    degraded = counts[ClassExportStatus.DEGRADED]
    return ExportCompatibility(
        release_id=release.id,
        format_name=exporter.format_name,
        target=None if target is None else target.name,
        # Degraded counts against `compatible` exactly as dropped does: a polygon
        # arriving as a box has lost its shape, and the caller is asked before
        # that happens rather than told after.
        compatible=(
            dropped == 0 and degraded == 0 and not dropped_modalities and not untagged_assets
        ),
        format_is_lossy=exporter.lossy,
        excluded_annotations=dropped,
        excluded_assets=len(touched[ClassExportStatus.DROPPED]),
        degraded_annotations=degraded,
        degraded_assets=len(touched[ClassExportStatus.DEGRADED]),
        classes=tuple(classes),
        dropped_modalities=dropped_modalities,
        untagged_assets=untagged_assets,
    )


_LOSS_ORDER: Final = {
    ClassExportStatus.SUPPORTED: 0,
    ClassExportStatus.DEGRADED: 1,
    ClassExportStatus.DROPPED: 2,
}


def _untracked(manifest: Manifest, exporter: Exporter) -> frozenset[UUID]:
    """The labels no track observes, when the format writes only observed ones."""
    if not getattr(exporter, "tracked_only", False):
        return frozenset()
    observed = {
        observation.annotation_id for track in manifest.tracks for observation in track.observations
    }
    return frozenset(
        annotation.id
        for asset in manifest.assets
        for annotation in asset.annotations
        if annotation.id not in observed
    )


def _single_tagged(
    manifest: Manifest, exporter: Exporter, target: ExportTarget | None
) -> tuple[frozenset[UUID], int]:
    """The tags a single-tag format drops beside the one it keeps, and the assets it leaves out."""
    if not getattr(exporter, "single_tag", False):
        return frozenset(), 0
    if _status_of(GeometryType.CLASSIFICATION_TAG, exporter, target) is ClassExportStatus.DROPPED:
        return frozenset(), len(manifest.assets)
    surplus: set[UUID] = set()
    untagged = 0
    for asset in manifest.assets:
        kept, dropped = single_tag(asset.annotations)
        untagged += kept is None
        surplus.update(one.id for one in dropped)
    return frozenset(surplus), untagged


def _crop_status(cropping: _Cropping | None, annotation_id: UUID) -> ClassExportStatus | None:
    if cropping is None:
        return None
    if annotation_id in cropping.dropped:
        return ClassExportStatus.DROPPED
    if annotation_id in cropping.clipped:
        return ClassExportStatus.DEGRADED
    return None


def _crop_reason(cropping: _Cropping | None, status: ClassExportStatus, count: int) -> str:
    strategy = "cropping" if cropping is None else cropping.strategy
    if status is ClassExportStatus.DROPPED:
        return f"the {strategy} resize cuts these {count} off the canvas"
    return f"the {strategy} resize cuts these {count} down to the part on the canvas"


def _openable(manifest: Manifest, exporter: Exporter) -> Manifest:
    """The manifest without the assets whose modality the format cannot open."""
    writes = supported_modalities_of(exporter)
    return manifest.model_copy(
        update={"assets": tuple(asset for asset in manifest.assets if asset.modality in writes)}
    )


def _handed(manifest: Manifest, exporter: Exporter, target: ExportTarget | None) -> Manifest:
    """The manifest an export hands the plugin and runs its recipe over.

    A target narrows it to what the target carries. Without one, only the 3D
    labels the format does not write are taken out: they are reported dropped
    and consented to like any loss, and no pixel-moving step can follow them,
    so leaving them in would refuse a resize for a label the export never
    writes. Every other geometry is the plugin's to drop, as it always was.

    An asset of a modality the format does not open is never handed over: the
    report already counts it dropped, and no plugin is asked to read a scan
    as an image.
    """
    manifest = _openable(manifest, exporter)
    if target is not None:
        return _addressed_to(manifest, target.supported_geometries)
    written = exporter.supported_geometries | exporter.degraded_geometries
    return _addressed_to(manifest, (IMPLEMENTED_GEOMETRIES - THREE_D) | written)


def _addressed_to(manifest: Manifest, carried: frozenset[GeometryType]) -> Manifest:
    """The manifest with every annotation outside ``carried`` removed.

    The classes stay: a class index is the frozen schema's, and a target that
    drops every polygon of a class still has that class in its vocabulary.
    """
    assets = tuple(
        asset.model_copy(
            update={
                "annotations": tuple(
                    one for one in asset.annotations if GeometryType(one.geometry.type) in carried
                )
            }
        )
        for asset in manifest.assets
    )
    return manifest_within(manifest, assets)


def _status_of(
    geometry: GeometryType, exporter: Exporter, target: ExportTarget | None
) -> ClassExportStatus:
    """What this format does with this geometry, from its own two declarations.

    A target, when given, can only take away: a geometry the format writes
    whole is dropped when the target does not carry it, because the export is
    addressed to a trainer that has no task for it.

    ``supported`` wins when a plugin declares a geometry in both sets. They are
    documented as disjoint, and a plugin claiming a geometry is simultaneously
    written whole and written reduced has said something contradictory — but
    resolving it towards the *weaker* claim would report a loss that does not
    happen, which is the mirror of the bug this function was rewritten for.
    """
    if geometry in exporter.supported_geometries:
        if target is not None and geometry not in target.supported_geometries:
            return ClassExportStatus.DROPPED
        return ClassExportStatus.SUPPORTED
    if geometry in exporter.degraded_geometries:
        return ClassExportStatus.DEGRADED
    return ClassExportStatus.DROPPED


def _reason_for(
    status: ClassExportStatus,
    geometry: GeometryType,
    exporter: Exporter,
    target: ExportTarget | None = None,
) -> str | None:
    """One sentence saying what happens to this class, or ``None`` if nothing does.

    A degraded reason says the class **is** written and what it costs; a dropped
    one says it is not written. That is the whole reason the two are separate
    values: one string covering both ends up saying "cannot write", which is
    false for half of what it describes.

    The kernel does not know *how* a plugin reduces a geometry — the port
    declares that something is lost, not what the remains look like — so the
    specific sentence is written only when the format's own declarations make it
    inevitable: a format that reduces a shape and can write a box writes the box.
    Anything else gets the honest general sentence rather than a guess, and a
    format wanting to say more says it in its own documentation.
    """
    if status is ClassExportStatus.SUPPORTED:
        return None
    if status is ClassExportStatus.DROPPED:
        if target is not None and geometry in exporter.supported_geometries:
            return f"{target.label} does not accept a {geometry.value}, so the export drops it"
        return f"{exporter.format_name} cannot place a {geometry.value} and drops it"
    if GeometryType.BBOX in exporter.supported_geometries:
        return (
            f"{exporter.format_name} writes a {geometry.value} as its bounding box; "
            f"the shape is lost"
        )
    return f"{exporter.format_name} writes a {geometry.value} in a reduced form; detail is lost"


def _loss_reason(compatibility: ExportCompatibility) -> str:
    """Why consent is being asked for, in the refusal's own sentence.

    The per-class breakdown is ``check``'s; this is the headline, so the person
    who hits the refusal does not have to run a second command to learn what it
    is about.
    """
    parts = []
    if compatibility.excluded_annotations:
        parts.append(f"{compatibility.excluded_annotations} annotation(s) would be left out")
    if compatibility.degraded_annotations:
        parts.append(f"{compatibility.degraded_annotations} would be reduced")
    if compatibility.untagged_assets:
        parts.append(f"{compatibility.untagged_assets} asset(s) carry no tag and would be left out")
    if not parts:
        parts.append("the format is lossy by declaration")
    return "; ".join(parts)
