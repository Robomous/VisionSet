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
  workspace should have kept, which is ``WorkspaceCorrupt`` — the reading #9
  established for a broken parent link.

There is deliberately no ``delete``. A release is the immutable artifact, and the
only thing that removes one is deleting its project, whose cascade takes it. Even
then the manifest blob survives: blobs are never deleted.

There is also no ``confirm=``. That guard is for destroying data, and publishing
destroys nothing — so this is not a third exemption from ``ConfirmationRequired``
and that docstring stays as it is.

Composition follows the rule in ``docs/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from typing import BinaryIO
from uuid import UUID

from pydantic import ValidationError

from visionset import __version__
from visionset.kernel.domain import (
    Annotation,
    Asset,
    Dataset,
    ExportResult,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    Release,
    ReleasePublished,
    ReleaseVerification,
    SplitAssignment,
    SplitRecipe,
    assign_split,
    canonical_bytes,
    normalize_name,
    sha256_hex,
)
from visionset.kernel.errors import (
    ConstraintViolated,
    EmptyRelease,
    LossyExportNotConsented,
    NoSplitRecipe,
    ReleaseNotFound,
    ReleaseTagTaken,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import BlobStore, Exporter, UnitOfWork
from visionset.kernel.services.dataset_service import DatasetService, assets_of
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.workspace_service import WorkspaceService

#: How SQLite words the tag index's refusal. Matched rather than parsed, and
#: matched exactly, so that a different constraint failing is never mistaken for
#: this one — the ``ProjectService`` precedent.
_TAG_INDEX_MESSAGE = "release.dataset_id, release.tag"


class ReleaseService:
    """Publish immutable snapshots of a dataset, and check they are still intact."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._datasets = DatasetService(workspace)
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
            WorkspaceCorrupt: the trunk holds an asset that is not stored.
        """
        cleaned = normalize_name(tag, what="release tag")
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

                manifest = Manifest(
                    schema_version=active.version,
                    classes=active.classes,
                    assets=_manifest_assets(uow, assets),
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
        cleaned = normalize_name(tag, what="release tag")
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

    def export(
        self,
        release_id: UUID,
        exporter: Exporter,
        dest: Path,
        *,
        allow_lossy: bool = False,
    ) -> ExportResult:
        """Write this release into ``dest`` in the exporter's format.

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

        The plugin runs outside any transaction. It is third-party code doing
        file I/O over what may be a very large manifest, and holding the
        workspace's single writer open across it is how a store starts reporting
        "database is locked" — the rule ``IngestService`` follows for a decode.

        Nothing here is recorded. An export produces no row, no event and no
        change-log entry: it reads a frozen artifact and writes outside the
        workspace's own files, so there is no state to keep in step. Re-running
        one is therefore free and always agrees with itself.

        ``dest`` is created if it is not there and is **not** emptied if it is.
        Deleting files under a path a caller named is not this service's to do,
        so the counts describe the directory once the plugin has run rather than
        the run alone — identical for a fresh directory, and different for one
        holding an older export. A caller that needs the stricter reading clears
        the directory first, which is what the REST surface does with the path it
        owns.

        Raises:
            ReleaseNotFound: no such release in this workspace.
            LossyExportNotConsented: the format drops information and the caller
                has not said that is acceptable.
            WorkspaceCorrupt: the manifest blob is gone, or is not a manifest.
        """
        release = self.get(release_id)
        if exporter.lossy and not allow_lossy:
            raise LossyExportNotConsented(
                f"format {exporter.format_name!r} cannot carry everything release "
                f"{release.tag!r} holds; re-run with allow_lossy to accept the loss"
            )
        manifest = self._read_manifest(release)
        dest.mkdir(parents=True, exist_ok=True)
        exporter.export(release, manifest, dest)
        written = [path for path in dest.rglob("*") if path.is_file()]
        return ExportResult(
            release_id=release.id,
            format_name=exporter.format_name,
            directory=dest,
            file_count=len(written),
            total_bytes=sum(path.stat().st_size for path in written),
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
        cascades from ``dataset``, so that is a guarantee failing, which is the
        reading #9 settled on for a broken parent link.
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
    """
    return tuple(
        ManifestAsset(
            asset_id=asset.id,
            content_hash=asset.content_hash,
            uri=asset.uri,
            width=asset.width,
            height=asset.height,
            annotations=tuple(_manifest_annotation(a) for a in uow.annotations.list(asset.id)),
        )
        for asset in assets
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
    keep intact and did not, which is corruption rather than a missing entity,
    the reading #9 settled for a broken parent link. Letting a
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
