/**
 * DO NOT EDIT — generated from the repo-root openapi.json.
 *
 * Regenerate with `pnpm generate:client` and commit the result. CI fails on drift.
 *
 * Binary responses (asset content, thumbnails, the release manifest, the export archive) type as
 * `unknown`: the spec declares them with an empty schema, and calling them `string` would be a
 * lie in a browser where the value is a Blob. Read those through `response.blob()`.
 */
export interface paths {
    "/background-jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Background Jobs
         * @description Every job this workspace has run, newest first.
         *
         *     Newest first because the caller is looking at what is happening now — the
         *     opposite order to the one the dispatcher claims in, which is oldest first.
         *
         *     No paging parameters. The collection is bounded by how much work a workspace
         *     has ever queued, which is the same order of magnitude as its ingest runs, and
         *     `limit`/`offset` join `total` without a breaking change on the day one has a
         *     caller — the rule `docs/api.md` states for every collection here.
         */
        get: operations["list_background_jobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/background-jobs/{job_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Background Job
         * @description Where a queued unit of work is now.
         *
         *     The generic twin of `GET /ingest-jobs/{id}`, and the same contract:
         *     `processed` and `total` are written while the run is in flight, so this
         *     answers "where is it" rather than "where did it end". `total` is null when the
         *     work cannot know it in advance.
         *
         *     Terminal states are `succeeded`, `failed` and `cancelled`. A finished job
         *     keeps its counters where they stopped; `error` says why a failure failed, and
         *     `result` carries whatever the work produced — for an export, the archive
         *     `GET /background-jobs/{id}/artifact` will hand back.
         */
        get: operations["get_background_job"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/background-jobs/{job_id}/artifact": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Background Job Artifact
         * @description Download whatever the job left behind. Today that is an export archive.
         *
         *     A **second route rather than bytes on the poll**, because the two are read on
         *     different schedules: a client polls this job every couple of seconds and wants
         *     JSON each time, and asks for the archive exactly once.
         *
         *     The path comes from the job's own `result`, is **relative to the workspace
         *     root**, and is rejoined here — an absolute path is a server-side path, which
         *     is the rule that keeps `Source.path` and `Asset.uri` off the wire. It is also
         *     re-checked to be inside the root before anything is opened: the value has been
         *     through a JSON column, and a route that trusts a stored path to stay inside
         *     the directory it was written for is one bad row away from serving `/etc`.
         *
         *     404 if the job never produced one, or if the file is gone — an export
         *     directory is not garbage-collected, but a workspace is a directory somebody
         *     can tidy. 409 while the job has not succeeded, because "not yet" and "never"
         *     are different answers and only one of them is worth retrying.
         */
        get: operations["get_background_job_artifact"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/background-jobs/{job_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel Background Job
         * @description Ask a job to stop, and answer with where that left it.
         *
         *     **Two different things behind one verb, and the answer says which happened.**
         *     A `queued` job has not started, so it comes back `cancelled` outright. A
         *     `running` job is only *told*: `cancel_requested` becomes true, `state` stays
         *     `running`, and the work stops at the next point its handler considers safe —
         *     which for a job with no such point is not until it finishes. Nothing is ever
         *     killed mid-write.
         *
         *     Cancelling a job that has already settled is a no-op that returns it
         *     unchanged, not a refusal: the caller wanted it stopped and it is stopped.
         *
         *     200 rather than 202, because this answers with the state it produced rather
         *     than promising something later.
         */
        post: operations["cancel_background_job"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/batches/{batch_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Batch
         * @description The batch, with how far its assets have got.
         *
         *     `progress` counts every asset of every job in the batch, so a draft — which
         *     has no jobs yet — reports zeros across the board while `asset_count` is
         *     already whatever the ingest gathered. `schema_version` is null until approval
         *     pins one, and moves after that only through `repin`.
         */
        get: operations["get_batch"];
        put?: never;
        post?: never;
        /**
         * Delete Batch
         * @description Remove a batch, its task groups, its jobs and their progress.
         *
         *     **The work survives.** Annotations hang off assets rather than off batches,
         *     so deleting the unit of work never deletes the labels; the assets stay in
         *     their project and in every other batch that carries them, and no blob is
         *     touched. What goes is the batch's own record of *organisation* — how the work
         *     was cut into jobs, and how far each asset had got.
         *
         *     A `completed` batch cannot be deleted at all and answers 409
         *     `BATCH_IMMUTABLE`: it is the record of what was labeled, against which pinned
         *     schema version, and what was deliberately skipped, which is what promotion
         *     and every later correction are read against. **No flag lifts that**, which is
         *     also why it is checked before `confirm` — a refusal naming a remedy that does
         *     not work is worse than a blunt one.
         *
         *     Without `confirm=true` this answers 409 `CONFIRMATION_REQUIRED` and destroys
         *     nothing.
         */
        delete: operations["delete_batch"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/batches/{batch_id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve Batch
         * @description Freeze the batch: pin the project's active schema version and cut it into jobs.
         *
         *     Everything after this is judged against the version pinned here, so a new
         *     schema version created while annotators are working does not change the rules
         *     under them. Membership stops being editable at the same moment — an asset
         *     that should not be labeled is marked `skipped` from here on, which keeps the
         *     decision on the record instead of erasing it.
         *
         *     The partition defaults to one job for the whole batch. `by_size` cuts jobs of
         *     a fixed length with the last taking the remainder; `by_segments` says exactly
         *     which assets go together, and is refused unless it reproduces the batch with
         *     nothing missing, repeated or foreign.
         *
         *     A batch that is not a draft is 409 `INVALID_TRANSITION`; an empty one is 409
         *     `EMPTY_BATCH`, because it would have no jobs and could never complete; a
         *     project with no schema is 404 `SCHEMA_NOT_FOUND`, since there is nothing to
         *     pin.
         */
        post: operations["approve_batch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/batches/{batch_id}/assets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Batch Assets
         * @description Everything in the batch, in membership order, with where each asset has got to.
         *
         *     The order is stored, so reading twice gives the same sequence and an ingest
         *     into an existing batch appends rather than reshuffles. `total` is the size of
         *     the whole batch and not of the page; an offset past the end is an empty list
         *     and a 200, never a 404.
         *
         *     `job_id` and `progress` are null while the batch is a draft, because a draft
         *     has no jobs. Bytes are not here: an asset is named by its hashes, and
         *     `GET /projects/{project_id}/assets/{asset_id}/content` is what serves them.
         */
        get: operations["list_batch_assets"];
        put?: never;
        /**
         * Add Batch Assets
         * @description Put assets into a draft batch.
         *
         *     **Only while the batch is a draft**, which is what `edit_membership` in its
         *     `allowed_actions` declares. Approval partitions the batch into jobs against a
         *     pinned schema version, so an asset added afterwards would belong to no job —
         *     hence 409 `BATCH_NOT_EDITABLE` from that point on, and there is no flag that
         *     lifts it.
         *
         *     Idempotent, and it says so in the answer rather than leaving it to be
         *     inferred: `changed` lists the ids this call actually wrote, so adding three
         *     assets of which two were already members reports one. An asset the batch
         *     already holds is not an error.
         *
         *     An id that is not an asset of this batch's project is 404 `ASSET_NOT_FOUND`
         *     and **nothing is written** — the whole call is refused, for the reason
         *     annotation writes are all-or-nothing.
         */
        post: operations["add_batch_assets"];
        /**
         * Remove Batch Assets
         * @description Take assets out of a draft batch. One transaction, however many ids you pass.
         *
         *     **This removes membership, not assets.** The asset stays in its project, in
         *     the blob store, and in every other batch that carries it; only this batch
         *     stops listing it.
         *
         *     Draft only, like adding, and for the sharper half of the same reason: after
         *     approval a job already describes work over that asset, and removing the
         *     member would leave the job describing work that no longer exists. From then
         *     on the way to exclude an asset is to mark it `skipped` — a decision the
         *     record keeps rather than erases — and this answers 409 `BATCH_NOT_EDITABLE`.
         *
         *     An id the batch does not hold is ignored rather than refused, and `changed`
         *     reports what actually went, so "removed 3" can be told from "3 were already
         *     gone".
         */
        delete: operations["remove_batch_assets"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/batches/{batch_id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Complete Batch
         * @description Close the batch, if every one of its jobs is finished.
         *
         *     Derived rather than declared: this reads the jobs and answers 409
         *     `BATCH_NOT_COMPLETE` while any of them is outstanding. A completed batch is
         *     what lets its annotated assets be promoted into the project's dataset.
         */
        post: operations["complete_batch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/batches/{batch_id}/corrections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create Correction Batch
         * @description Cut a new draft batch that corrects this completed one.
         *
         *     **The forward-only answer to "this needs fixing".** A `completed` batch is
         *     immutable as a workflow unit — it has no exit in the lifecycle and none is
         *     coming — so changing settled work means a new batch over the same assets,
         *     carrying lineage back to this one in `parent_batch_id`.
         *
         *     Addressed as a sub-resource of the parent because the parent is what decides:
         *     `create_correction` is declared on `BatchOut` exactly while the batch is
         *     `completed`, and a 409 is what a client gets for asking otherwise.
         *
         *     `asset_ids` defaults to **the parent's whole membership**, since "correct
         *     this batch" is the ordinary ask. A subset is the other one — the three frames
         *     somebody found wrong — and every id given must be one the parent carried: a
         *     correction of a batch is a correction *of what was in it*.
         *
         *     The child pins the project's **active** schema at its own approval, not the
         *     parent's pin. That is the point of correcting under a contract that has moved
         *     on, and it is the ordinary approval mechanism rather than anything new.
         */
        post: operations["create_correction_batch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/batches/{batch_id}/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Batch Jobs
         * @description The jobs the batch was cut into, in segment order.
         *
         *     Empty until the batch is approved — a draft has no jobs — and a 200 either
         *     way.
         */
        get: operations["list_batch_jobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/batches/{batch_id}/promote": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Promote Batch
         * @description Move the batch's labeled assets into its project's dataset.
         *
         *     The one gate into the trunk. Which assets go in is derived, not chosen: those
         *     an annotator left `annotated` or a reviewer left `accepted`. A `skipped`
         *     asset stays out by design, and the decision stays on the record rather than
         *     being erased from the batch.
         *
         *     Idempotent, and a union rather than a replacement. Promoting the same batch
         *     twice returns an empty list the second time and writes no change-log entry,
         *     because nothing happened — and re-promoting after a curator removed an asset
         *     puts it back, since the trunk keeps no memory of removals.
         *
         *     A batch that has not reached `completed` is 409 `BATCH_NOT_COMPLETE`.
         */
        post: operations["promote_batch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/batches/{batch_id}/repin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Repin Batch
         * @description Move the batch's schema pin onto the project's current active version.
         *
         *     Explicit, never automatic — the pin does not follow the schema, because a
         *     contract that moved under work in flight is what versioning exists to
         *     prevent. This is how a class added *after* approval becomes usable in a batch
         *     somebody is already annotating, without abandoning it.
         *
         *     Adding a class is additive and goes through with no flag. A change that
         *     narrows what the pin allowed — a class removed, a geometry changed, an
         *     attribute made required — is 409 `DESTRUCTIVE_SCHEMA_CHANGE`; retry the
         *     identical request with `?allow_destructive=true`. If this batch already holds
         *     annotations under a class the change would break, it is 409
         *     `SCHEMA_CHANGE_WOULD_ORPHAN` and **no flag overrides it** — branch on the
         *     code, never on the status. The orphan check is scoped to this batch: a label
         *     written in some *other* batch does not block this one.
         *
         *     Legal only while the batch is `approved` or `in_annotation`; a draft has no
         *     pin yet and a completed batch's pin is history, both 409
         *     `INVALID_TRANSITION`. Re-pinning onto the version already pinned changes
         *     nothing. Annotations already written keep the version they were stamped with.
         */
        post: operations["repin_batch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/batches/{batch_id}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start Batch
         * @description Open the batch for annotation. Nothing may be written into it before this.
         */
        post: operations["start_batch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/datasets/{dataset_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Dataset
         * @description The dataset with that id.
         */
        get: operations["get_dataset"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/datasets/{dataset_id}/assets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Dataset Assets
         * @description Everything in the trunk, in the order it was promoted.
         *
         *     Paged, and the second route in the API that is — the trunk accumulates every
         *     batch a project ever completed, so it is the other collection that can hold
         *     fifty thousand items. `total` is the size of the whole trunk and not of the
         *     page; an offset past the end is an empty list and a 200, never a 404.
         *
         *     Order is the stored insertion order, so reading twice gives the same sequence
         *     and promoting a new batch appends rather than reshuffles.
         */
        get: operations["list_dataset_assets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/datasets/{dataset_id}/assets/{asset_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove Dataset Asset
         * @description Take one asset out of the trunk.
         *
         *     Curation, not deletion: the asset, its annotations and its bytes all stay
         *     exactly where they were, and only the membership row goes. That is why there
         *     is no `confirm` gate here — there is nothing to destroy.
         *
         *     204 whether or not the asset was a member. An id that was never in the trunk
         *     leaves it in the state the caller asked for, and reporting that as a 404
         *     would make a retry of a successful request look like a failure. The change
         *     log records only the calls that actually changed something.
         *
         *     Not permanent, either: re-promoting the batch the asset came from puts it
         *     back, because the trunk keeps no memory of removals.
         */
        delete: operations["remove_dataset_asset"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/datasets/{dataset_id}/changes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Dataset Changes
         * @description The trunk's append-only mutation log, oldest entry first.
         *
         *     Every line is a change somebody can point at: a promote that added nothing
         *     writes no entry, and neither does removing an asset that was not there.
         *     Entries are never updated or deleted.
         *
         *     `subject_ids` is shaped by the operation — for `promote` it is the batch
         *     followed by the assets it contributed, and for `remove_asset` it is the one
         *     asset. `operation` is an open string rather than an enum, so an entry written
         *     by a later VisionSet naming an operation this build has not heard of is still
         *     readable.
         */
        get: operations["list_dataset_changes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/datasets/{dataset_id}/releases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Releases
         * @description Every release of that dataset, oldest first.
         */
        get: operations["list_releases"];
        put?: never;
        /**
         * Publish Release
         * @description Freeze the trunk as it stands into an immutable, named snapshot.
         *
         *     What is frozen is the content: every member asset, every annotation on it as
         *     it was, and the schema version those labels were judged against. Deleting an
         *     annotation afterwards cannot reach backwards into a published release.
         *
         *     Publishing twice from an unchanged dataset produces byte-identical manifests
         *     and therefore the same `manifest_hash`, because nothing time-, machine- or
         *     identity-specific goes inside the document. The tag, the timestamp and the
         *     build live on the release row instead.
         *
         *     `split` is stored as a recipe, not materialized. `GET
         *     /releases/{release_id}/assignment` cuts the folds on demand, deterministically
         *     and from the frozen asset set. Fractions must sum to 1.0.
         *
         *     Tags are unique per dataset and **case-sensitive**, like a git tag: `v1.0` and
         *     `V1.0` are two releases, and reusing one is 409 `RELEASE_TAG_TAKEN`. A dataset
         *     with no assets is 409 `EMPTY_RELEASE`; zero *annotations* is fine, since
         *     unlabeled images are legitimate training data. A project with no schema is 404
         *     `SCHEMA_NOT_FOUND`, because there is no version to pin.
         */
        post: operations["publish_release"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/datasets/{dataset_id}/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Dataset Stats
         * @description What the trunk currently holds, counted overall and per label class.
         *
         *     Counted on every call rather than cached, so it always describes the trunk as
         *     it stands. `classes` lists only classes that appear at least once — which
         *     classes *exist* is a property of the schema, and `GET
         *     /projects/{project_id}/schema` is where to read that.
         *
         *     Per class you get both numbers because they answer different questions: a
         *     thousand `sign` boxes over a thousand images and the same thousand over ten
         *     are the same `annotations` and a very different dataset.
         *
         *     `asset_count` minus `annotated_asset_count` is how many members carry no
         *     labels at all, which is legitimate — unlabeled images are training data, and
         *     only a release of *zero* assets is refused.
         */
        get: operations["dataset_stats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/formats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Formats
         * @description Every export format installed on this server, by name.
         *
         *     `name` is what `POST /releases/{release_id}/export?format=` takes.
         *
         *     `lossy` says the format cannot carry everything the kernel can represent —
         *     some geometry, attribute kind, or per-annotation provenance is dropped. It is
         *     a property of the format rather than of any one release, so it is answered
         *     here and not per export, and exporting in one requires `allow_lossy=true`.
         *
         *     Never empty in practice: a built-in no-op format ships with VisionSet so the
         *     plugin path is exercised even before a real exporter is installed.
         */
        get: operations["list_formats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Health
         * @description Liveness probe. Public — no token required.
         */
        get: operations["health"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/inference/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Inference Connections
         * @description Every configured connection in this workspace, in the order they were made.
         */
        get: operations["list_inference_connections"];
        put?: never;
        /**
         * Create Inference Connection
         * @description Configure a connection. Nothing is downloaded and nothing is contacted.
         */
        post: operations["create_inference_connection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/inference/connections/{connection_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Inference Connection
         * @description The connection with that id.
         */
        get: operations["get_inference_connection"];
        put?: never;
        post?: never;
        /**
         * Delete Inference Connection
         * @description Remove a connection. Annotations keep the model provenance they recorded.
         *
         *     No ``confirm`` gate, unlike deleting a project: nothing holds a key to this
         *     row, because an annotation copies its model's identity at write time rather
         *     than pointing here (`cf. #417`). What is destroyed is a configuration.
         */
        delete: operations["delete_inference_connection"];
        options?: never;
        head?: never;
        /**
         * Update Inference Connection
         * @description Edit a connection. Omitted fields are left alone; the kind cannot change.
         */
        patch: operations["update_inference_connection"];
        trace?: never;
    };
    "/ingest-jobs/{job_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Ingest Job
         * @description Where a run is now.
         *
         *     `processed` and `total` are written as the run goes, so this answers "where
         *     is it" rather than "where did it end". `total` is null for a clip — a video's
         *     frame count is a guess before extraction, so it is not reported.
         *
         *     Terminal states are `completed` and `failed`. A `failed` job keeps its
         *     counters exactly where they stopped, and `error` says why; unreadable
         *     individual items are in `failures` and never fail a run on their own.
         */
        get: operations["get_ingest_job"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ingest-jobs/{job_id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resume Ingest
         * @description Run a failed job again, on the same row and into the same batch.
         *
         *     A redo, not a skip: the whole source is read again. That creates nothing it
         *     created before — content is addressed by hash and assets are deduplicated —
         *     so the cost is re-reading and the gain is that resume has no second code path.
         *
         *     A `completed` job cannot be resumed, and neither can one stuck at `running`:
         *     that is a process that died without reporting, so ingest the source again
         *     instead, which creates nothing and leaves the stuck row as the record it is.
         *     Both answer 409 `INVALID_TRANSITION`.
         */
        post: operations["resume_ingest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Job
         * @description The job, and the batch it is a segment of.
         *
         *     `batch_id` is the handle worth having: it leads to the schema version this
         *     job's work is judged against, which a job id alone does not.
         */
        get: operations["get_job"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}/annotations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add Annotations
         * @description Store annotations, judged against the version this job's batch pinned.
         *
         *     All-or-nothing: every annotation is validated before any of them is written,
         *     so a payload with one bad box stores nothing at all. A half-labeled asset is
         *     not a state a client can reach.
         *
         *     A refusal that is about one item carries `detail.index` — the position in the
         *     array you sent — because nothing was written and the message alone cannot say
         *     which one it was. `schema_version` is not yours to set: the pinned version is
         *     stamped onto whatever you send, and comes back on the response.
         *
         *     The batch must be `in_annotation`, or this is 409
         *     `BATCH_NOT_IN_ANNOTATION`. An asset the job does not carry is 422
         *     `ASSET_NOT_IN_JOB`.
         *
         *     The asset must also still be open for labeling — `unannotated` or
         *     `annotated`. One that was skipped, submitted for review or accepted is 409
         *     `ASSET_NOT_WRITABLE`, and the message names the state it is in. The remedy is
         *     a progress move where the table allows one (`skipped` back to `unannotated`);
         *     `accepted` has no exit, so correcting it means a new batch. Read
         *     `allowed_actions` on the batch's asset listing rather than guessing: it
         *     declares `annotate` exactly when this will be accepted.
         */
        post: operations["add_annotations"];
        /**
         * Delete Annotations
         * @description Remove annotations. One transaction, however many ids you pass.
         *
         *     Repeating an id is not two deletions. An id that is not stored refuses the
         *     whole call with 404 `ANNOTATION_NOT_FOUND` and removes nothing — there is no
         *     partial delete, for the reason there is no partial write. Removing a label is
         *     still a write, so an asset that was skipped, submitted or accepted is 409
         *     `ASSET_NOT_WRITABLE` here too.
         *
         *     No confirmation gate: taking a box off is the ordinary annotator edit loop,
         *     not the destruction of a lifecycle entity. The batch gate is the guard, so
         *     once the work closes nothing here can touch it at all.
         */
        delete: operations["delete_annotations"];
        options?: never;
        head?: never;
        /**
         * Update Annotations
         * @description Replace stored annotations whole, judged against the same pinned version.
         *
         *     Addressed by `id` and by nothing else — annotations are never reached by
         *     index or position. There is no `asset_id` on the body because the stored one
         *     wins: moving a label from one asset to another is a delete and an add, not an
         *     edit, and doing it silently would take an asset's last annotation away
         *     without anything saying so.
         *
         *     All-or-nothing, and `detail.index` names the culprit, exactly as on the POST.
         *     An asset whose labeling is over is 409 `ASSET_NOT_WRITABLE`, as on the POST.
         */
        patch: operations["update_annotations"];
        trace?: never;
    };
    "/jobs/{job_id}/assets/{asset_id}/annotations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Asset Annotations
         * @description Every annotation on one asset of this job, in the order they were added.
         *
         *     Empty for an asset nobody has labeled yet — the ordinary starting state, not
         *     an error. Reading is not gated on the batch being open: a label outlives the
         *     work that produced it.
         */
        get: operations["list_asset_annotations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}/assets/{asset_id}/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set Asset Progress
         * @description Record where one asset of this job has got to.
         *
         *     One route rather than five verbs, because the legal moves are a table in the
         *     kernel and a second spelling of it would drift: `unannotated` to `annotated`
         *     or `skipped`, `annotated` to `review_pending` or back, `review_pending` to
         *     `accepted` or back to `annotated`, and `accepted` nowhere at all. Anything
         *     else is 409 `INVALID_TRANSITION`.
         *
         *     Setting the state an asset is already in is a no-op rather than a refusal —
         *     but the batch gate fires first, so writing into a closed batch is refused
         *     whether or not the value would have changed.
         *
         *     Labels move `unannotated` and `annotated` on their own as annotations are
         *     added and deleted. This route is for the decisions that are nobody's
         *     consequence: skipping, submitting for review, accepting.
         */
        put: operations["set_asset_progress"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Complete Job
         * @description Close the job, if every asset in it has been dealt with.
         *
         *     Dealt with means `annotated`, `skipped` or `accepted`. An `unannotated` asset
         *     means the labeling has not happened and a `review_pending` one means the
         *     review has not; either answers 409 `JOB_NOT_COMPLETE` and says how many are
         *     outstanding.
         *
         *     Completing a job does not complete its batch — `POST /batches/{id}/complete`
         *     derives that from all of them.
         */
        post: operations["complete_job"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}/next": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Next Pending Assets
         * @description The next assets waiting to be labeled, in the batch's own order.
         *
         *     Only `unannotated` ones: this answers the annotator's question, and an asset
         *     in `review_pending` is waiting on a reviewer rather than on labeling. The
         *     order is stored, so the same call twice returns the same assets — and marking
         *     an unrelated one does not reshuffle what is left.
         *
         *     Fewer than `n` come back when fewer remain, and nothing at all once the job
         *     is done. `total` is the size of this answer, not of the job; the job's own
         *     tally is at `GET /jobs/{job_id}/progress`.
         */
        get: operations["next_pending_assets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Job Progress
         * @description How many of this job's assets sit in each state.
         *
         *     Every state is a field, including the ones nobody is in, so a client charting
         *     progress never has to guard a lookup.
         */
        get: operations["get_job_progress"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start Job
         * @description Take the job from `pending` to `in_progress`.
         *
         *     The batch has to be open first: a job in a batch nobody started is 409
         *     `BATCH_NOT_IN_ANNOTATION`.
         */
        post: operations["start_job"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Projects
         * @description Every project in this workspace, in the order they were created.
         */
        get: operations["list_projects"];
        put?: never;
        /**
         * Create Project
         * @description Add a project and its empty dataset, both or neither.
         */
        post: operations["create_project"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Project
         * @description The project with that id.
         */
        get: operations["get_project"];
        put?: never;
        post?: never;
        /**
         * Delete Project
         * @description Remove a project and everything under it.
         *
         *     Metadata only: content blobs are shared and are never deleted. Without
         *     `confirm=true` this answers 409 `CONFIRMATION_REQUIRED` and destroys nothing.
         */
        delete: operations["delete_project"];
        options?: never;
        head?: never;
        /**
         * Rename Project
         * @description Rename a project, and its dataset with it. The only field that moves.
         */
        patch: operations["rename_project"];
        trace?: never;
    };
    "/projects/{project_id}/assets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Project Assets
         * @description Every asset ingested into the project, in a stable order.
         *
         *     The third asset listing, and the one that had been missing: the other two
         *     window a *batch* and the curated *trunk*, and neither answers "show me this
         *     project". A project page asking for six sample tiles passes `limit=6` and
         *     reads `total` for the rest.
         *
         *     **The order is deterministic and it is not chronological.** Nothing records
         *     when an asset arrived, so assets are grouped by source, then by frame index
         *     for a clip, then by path for a directory, then by id. The practical effect is
         *     that a clip's frames come back in order and a directory's stills in filename
         *     order; the practical limit is that "the six most recent" cannot be asked for
         *     yet.
         *
         *     `total` is every asset in the project, never the size of this page, so a
         *     client showing six tiles computes its own overflow from `total - 6`.
         */
        get: operations["list_project_assets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/assets/{asset_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Asset
         * @description One ingested item, by id.
         *
         *     An asset belonging to a different project reads as 404 rather than 403, like
         *     every cross-scope reference here.
         *
         *     `content_hash` identifies the bytes and `thumbnail_hash` the cached preview,
         *     but neither is a URL — the two routes below are, and they take this asset's
         *     id.
         */
        get: operations["get_asset"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/assets/{asset_id}/batches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Asset Batches
         * @description Every batch that carries this asset, oldest membership first.
         *
         *     **The membership edge walked backwards.** Every other read goes from a batch
         *     to its assets; this asks which rounds of work an asset has been through, and
         *     it is what a correction batch's lineage looks like from the asset's side —
         *     the original and its corrections, in the order they were cut.
         *
         *     A dedicated route rather than a field on `AssetOut`, and the reason is cost:
         *     a listing of fifty thousand assets would pay one join per row for a fact
         *     almost no reader of that listing wants. This is asked about one asset, by
         *     somebody looking at that asset.
         *
         *     An asset in no batch answers `{"items": [], "total": 0}` — the ordinary state
         *     of anything ingested without a target, and not a 404. The 404 here is for the
         *     asset or the project, which is resolved first.
         */
        get: operations["list_asset_batches"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/assets/{asset_id}/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Asset Content
         * @description The asset's own bytes, streamed.
         *
         *     The original that was ingested, not a re-encode — for a video frame that is
         *     the PNG extraction wrote, which is the picture an annotator drew on and the
         *     picture an exporter ships.
         *
         *     `Content-Type` comes from what the ingest actually probed. An asset written
         *     before the pipeline recorded a format is served as
         *     `application/octet-stream`, because inventing one would be worse than
         *     admitting it.
         *
         *     Cached forever and never revalidated: identity is content, so these bytes
         *     cannot change. The `ETag` is the content hash.
         *
         *     404 `WORKSPACE_CORRUPT` is not among the answers — a recorded hash with no
         *     blob behind it is a guarantee failing, and is 500.
         */
        get: operations["get_asset_content"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/assets/{asset_id}/thumbnail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Asset Thumbnail
         * @description The asset's cached preview, streamed. Always JPEG.
         *
         *     A preview is a cache, so this reads one and never renders one. An asset with
         *     no preview is 404 `THUMBNAIL_NOT_CACHED` — which has three causes with one
         *     remedy: the asset predates the cache, its bytes would not render, or no run
         *     has reached it yet. A backfill fills what it can.
         *
         *     Cached the same way `content` is, and for the same reason. The `ETag` is the
         *     thumbnail hash, which is a cache key and not an identity: two machines may
         *     hold different preview bytes for one image, so never compare these across
         *     workspaces.
         */
        get: operations["get_asset_thumbnail"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/batches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Batches
         * @description Every batch of that project, in the order they were created.
         */
        get: operations["list_batches"];
        put?: never;
        /**
         * Create Batch
         * @description Start a draft batch over a chosen set of the project's assets.
         *
         *     **A batch is still born from an ingest in the ordinary case**, and this does
         *     not change that: an ingest run puts what it gathered into one, which is where
         *     almost every batch comes from. What had no surface at all was curating one
         *     out of an arbitrary subset — the shape a correction batch is, and the shape
         *     anybody re-cutting work by hand needs (cf. #281).
         *
         *     The batch is a `draft`, so its membership stays editable and approval is what
         *     freezes it and pins the schema. `asset_ids` may be empty: a batch nobody has
         *     filled yet is a legitimate intermediate state, and approving one is what
         *     `EmptyBatch` refuses.
         */
        post: operations["create_batch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/dataset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Project Dataset
         * @description The project's dataset.
         *
         *     Singular, and there is never a second one: the dataset is created with the
         *     project and its name moves with it. This is the route that turns a project id
         *     into the dataset id everything under `/datasets` needs.
         */
        get: operations["get_project_dataset"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/schema": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Active Schema
         * @description The version in force: the highest one.
         *
         *     A project that has no schema yet answers 404 `SCHEMA_NOT_FOUND`, which is a
         *     different code from the 404 `PROJECT_NOT_FOUND` an unknown project gets.
         *     Same status, two situations.
         */
        get: operations["get_active_schema"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/schema/compare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Compare Schema Versions
         * @description What one version did to another: the kernel's own classification.
         *
         *     A route rather than arithmetic a client could do for itself, because the rule
         *     is not obvious and there is exactly one correct spelling of it. Adding an
         *     *optional* attribute is additive while adding a *required* one is not;
         *     widening a `select` is additive and narrowing it is not; a rename reads as one
         *     removal plus one addition, because `Annotation.label_class` is matched by
         *     exact string too. A second implementation of that in a client would be free to
         *     drift from the one the API then enforces.
         *
         *     `is_destructive` and `destructive_classes` are the verdict, and they are what
         *     to branch on — a client re-deriving them from `changes` is re-implementing the
         *     thing this endpoint exists to avoid. Destructive here means "an annotation
         *     that was valid under `from` may not be valid under `to`", which is what
         *     decides whether applying or re-pinning needs `allow_destructive=true`.
         *
         *     Comparing a version with itself is an empty, non-destructive diff. Order
         *     matters: `from=1&to=2` and `from=2&to=1` are different questions, and the
         *     second is how you ask what going *back* would cost.
         *
         *     Either version missing is 404 `SCHEMA_NOT_FOUND`; an unknown project is 404
         *     `PROJECT_NOT_FOUND`. Same status, two situations, told apart by `code`.
         */
        get: operations["compare_schema_versions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/schema/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Schema Versions
         * @description Every version, oldest first. An empty page is the ordinary starting state.
         */
        get: operations["list_schema_versions"];
        put?: never;
        /**
         * Create Schema Version
         * @description Append the next version of the project's schema.
         *
         *     The body is the whole proposed version; versions are never edited in place.
         *
         *     `description` is this version's commit message — written once, here, and
         *     never afterwards, because a version is immutable and there is no route that
         *     edits one. Blank is legal and comes back as null. `created_at` is stamped by
         *     the server, so it is a response field and not a request one.
         *
         *     `provenance` says which kind of work is publishing: `curated` for a version
         *     authored in a schema editor, `annotation` for one that fell out of adding a
         *     class while labeling. It is stored exactly as sent and never inferred, so a
         *     client with no opinion omits it and the version records null — which readers
         *     group with `curated`. It gates nothing and changes no behaviour; it exists so
         *     a version history can separate the milestones from the runs.
         *
         *     Removing a class or an attribute answers 409 `DESTRUCTIVE_SCHEMA_CHANGE`
         *     until `allow_destructive=true` says so deliberately. If annotations already
         *     exist under an affected class it answers 409 `SCHEMA_CHANGE_WOULD_ORPHAN`
         *     instead, and **no flag overrides that one** — which is why a client branches
         *     on `code` and not on the status.
         */
        post: operations["create_schema_version"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/schema/versions/{version}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Schema Version
         * @description One version of a project's schema.
         */
        get: operations["get_schema_version"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Sources
         * @description Every source of that project, in registration order.
         */
        get: operations["list_sources"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/sources/images": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register Image Source
         * @description Offer a project a folder of stills.
         *
         *     The parts are staged as one directory and that directory becomes the source.
         *     Uploading the same files again returns the **same** source rather than a
         *     second one: staging is content-addressed, so identical bytes under identical
         *     filenames land on the same path, and registration is idempotent on that path.
         *
         *     Nothing is decoded here — what the files turn out to be is read at ingest,
         *     and a file that is not an image is reported there rather than refused now.
         *
         *     `name` exists because the staged path's basename is a digest (#245); a blank
         *     one is refused by the kernel's own `InvalidName` (422), the #28 rule — the
         *     domain already refuses with a mapped error, so no wire validator restates it.
         */
        post: operations["register_image_source"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/sources/video": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register Video Source
         * @description Offer a project a clip, to be cut at `extraction_fps`.
         *
         *     The clip is probed on the way in, so a file that is not a video, or one
         *     whose bytes will not decode, is 422 here rather than a run that fails later.
         *
         *     The rate is part of what the source *is*: the same clip registered at 1 fps
         *     and again at 5 fps is two sources over one file, which is what makes "the
         *     same source yields the same assets" mean anything.
         */
        post: operations["register_video_source"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Project Stats
         * @description What the project holds, counted — overall and per label class.
         *
         *     Counts **everything ingested**, whatever batch it landed in and whether or
         *     not anybody has promoted it. `GET /datasets/{dataset_id}/stats` is the
         *     sibling that counts the curated trunk, and the two disagree by design: a
         *     project mid-annotation has assets here and none there.
         *
         *     `class_count` is what the active schema version declares, so a project that
         *     has just authored an ontology and labeled nothing reports its classes.
         *     `annotated_pct` is `0` for a project with no assets, never `null`.
         *
         *     `classes` lists only classes somebody has actually used, ordered by name.
         */
        get: operations["get_project_stats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/releases/{release_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Release
         * @description The release with that id.
         *
         *     `schema_version`, `asset_count` and `annotation_count` are a read cache of
         *     facts that also live inside the manifest, kept out here so listing a
         *     dataset's releases does not open a blob per row. `verify` is what cross-checks
         *     them.
         */
        get: operations["get_release"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/releases/{release_id}/assignment": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Release Assignment
         * @description Materialize the release's split recipe into train/val/test folds.
         *
         *     Computed from the frozen manifest, never from the dataset as it stands today —
         *     reading live membership would let a curator change a published release's folds
         *     by editing the trunk afterwards.
         *
         *     Deterministic, and keyed on each asset's *content hash* rather than its id, so
         *     identical bytes land in the same fold and cannot straddle a train/test
         *     boundary. Nothing is stored; asking twice gives the same answer.
         *
         *     A release published without a recipe is 404 `NO_SPLIT_RECIPE`. That is not a
         *     defect in the release: no recipe means one undivided set, and answering
         *     all-train would be indistinguishable from a real recipe that said so.
         */
        get: operations["get_release_assignment"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/releases/{release_id}/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Export Release
         * @description Queue the release for writing, and answer at once with the job to poll.
         *
         *     **202, not 200, and this is a breaking change to this one endpoint.** It used
         *     to block until the exporter finished and answer with the archive. A real
         *     exporter walks every asset in a release and copies its bytes, which is
         *     minutes of work behind a request that has no way to report progress and every
         *     proxy's timeout in front of it. So this now follows the launch-and-poll
         *     contract the ingest routes have always used: poll
         *     `GET /background-jobs/{id}` — the `Location` header names it — until `state`
         *     is `succeeded`, then `GET /background-jobs/{id}/artifact` for the archive.
         *
         *     **Everything a caller can be told now is still told now.** Which formats
         *     exist is a property of this deployment — `GET /formats` lists what is
         *     installed — and an unknown name is 404 `EXPORT_FORMAT_NOT_FOUND` on this
         *     request. A format that cannot carry everything the release holds is 409
         *     `LOSSY_EXPORT_NOT_CONSENTED` on this request too, and retrying is the
         *     identical call plus `allow_lossy=true`. Neither refusal creates a job, so a
         *     caller holding a job id holds one that will run.
         *
         *     A POST because it does work and writes files, though it changes nothing a
         *     later read can see: the release is immutable, and re-exporting overwrites the
         *     previous archive.
         */
        post: operations["export_release"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/releases/{release_id}/export-compatibility": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Check Export
         * @description Say what the named format would drop from this release, without writing anything.
         *
         *     The pre-flight for `POST /releases/{release_id}/export`: same release, same
         *     format name, same document the export refuses with and writes into its own
         *     output. A client showing a consent dialog asks this first; one that would
         *     rather find out by being refused does not have to.
         *
         *     `compatible` is the answer. It is not the same question as the format's
         *     `lossy` flag, which `GET /formats` publishes: that is the format's blanket
         *     statement about everything a capability list cannot see, while this is about
         *     the labels *this* release actually holds. Export asks for `allow_lossy=true`
         *     when either says so.
         *
         *     A GET because it writes nothing and answers the same thing every time — a
         *     release is immutable, so this response is as stable as the release is.
         */
        get: operations["check_export"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/releases/{release_id}/manifest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Release Manifest
         * @description The frozen document itself, byte for byte.
         *
         *     Streamed straight off the blob store rather than parsed and re-serialized, so
         *     what arrives hashes to `manifest_hash` — which is the point of a hash-pinned
         *     artifact and would not survive a round trip through this build's JSON encoder.
         *
         *     Cached forever and never revalidated: the document is named by its own digest,
         *     so these bytes cannot change. The `ETag` is that digest.
         */
        get: operations["get_release_manifest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/releases/{release_id}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Verify Release
         * @description Re-read and re-hash everything this release names.
         *
         *     A report rather than a verdict, because "is this still intact?" has more than
         *     two useful answers and somebody looking at a damaged workspace needs the list.
         *     `missing` and `corrupt` are never merged: a blob that is gone was deleted out
         *     from under us, while one whose bytes no longer hash to its own name was
         *     altered in place, and the remedies differ.
         *
         *     `manifest_intact` is settled first. When it is false, `checked` is zero and
         *     every list is empty — an altered document is not an inventory worth walking.
         *
         *     `cache_mismatches` is where the release row disagrees with the document it
         *     names. Anything in it is a bug in this build rather than damage.
         *
         *     A GET because it changes nothing, but it is not free: it reads every blob the
         *     release names.
         */
        get: operations["verify_release"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sources/{source_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Source
         * @description The source with that id.
         */
        get: operations["get_source"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sources/{source_id}/ingest-jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Ingest Jobs
         * @description Every run of that source, in the order they were asked for.
         */
        get: operations["list_ingest_jobs"];
        put?: never;
        /**
         * Start Ingest
         * @description Launch a run over the source and answer at once with the job to poll.
         *
         *     **202, not 201**: the row exists, the work does not. Poll
         *     `GET /ingest-jobs/{id}` — the `Location` header names it — and watch
         *     `processed` climb until `state` is `completed` or `failed`.
         *
         *     A run that could not even be recorded is refused here; everything that goes
         *     wrong afterwards is reported *on the job*, which is the whole point of the
         *     shape. Unreadable files land in `failures` and do not fail the run; a
         *     missing ffmpeg does, in `error`.
         *
         *     `batch_id` puts what this run gathers into a batch that already exists,
         *     which is how a second source joins the first one's batch. It has to be a
         *     draft — an approved batch has been cut into jobs already, so adding to it is
         *     409 `BATCH_NOT_EDITABLE` — and an unknown one is a 404. Both are answered
         *     here, before the job row is written. `batch_name` names a new batch instead;
         *     passing neither uses the source's own name.
         */
        post: operations["start_ingest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * AnnotationCreate
         * @description One annotation to store, judged against the version its batch pinned.
         */
        AnnotationCreate: {
            /**
             * Asset Id
             * Format: uuid
             */
            asset_id: string;
            /**
             * Attributes
             * @default {}
             */
            attributes: {
                [key: string]: boolean | number | string;
            };
            /** Confidence */
            confidence?: number | null;
            /** Geometry */
            geometry: components["schemas"]["BboxBody"] | components["schemas"]["PolygonBody"] | components["schemas"]["PolylineBody"] | components["schemas"]["ClassificationBody"];
            /** Label Class */
            label_class: string;
            /** Model Ref */
            model_ref?: string | null;
            /**
             * Provenance
             * @enum {string}
             */
            provenance: "human" | "model" | "import";
        };
        /**
         * AnnotationJobState
         * @description Lifecycle: pending -> in_progress -> completed.
         *
         *     ``JOB_TRANSITIONS`` below is the whole of what is legal; ``JobService`` owns
         *     the moves.
         * @enum {string}
         */
        AnnotationJobState: "pending" | "in_progress" | "completed";
        /**
         * AnnotationOut
         * @description One stored annotation, in the asset's own pixel frame.
         */
        AnnotationOut: {
            /**
             * Asset Id
             * Format: uuid
             */
            asset_id: string;
            /** Attributes */
            attributes: {
                [key: string]: boolean | number | string;
            };
            /** Confidence */
            confidence: number | null;
            /** Geometry */
            geometry: components["schemas"]["BboxBody"] | components["schemas"]["PolygonBody"] | components["schemas"]["PolylineBody"] | components["schemas"]["ClassificationBody"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Job Id */
            job_id: string | null;
            /** Label Class */
            label_class: string;
            /** Model Ref */
            model_ref: string | null;
            /**
             * Provenance
             * @enum {string}
             */
            provenance: "human" | "model" | "import";
            /** Schema Version */
            schema_version: number;
        };
        /**
         * AnnotationPage
         * @description A page of annotations.
         */
        AnnotationPage: {
            /** Items */
            items: components["schemas"]["AnnotationOut"][];
            /** Total */
            total: number;
        };
        /**
         * AnnotationUpdate
         * @description One stored annotation, replaced whole.
         */
        AnnotationUpdate: {
            /**
             * Attributes
             * @default {}
             */
            attributes: {
                [key: string]: boolean | number | string;
            };
            /** Confidence */
            confidence?: number | null;
            /** Geometry */
            geometry: components["schemas"]["BboxBody"] | components["schemas"]["PolygonBody"] | components["schemas"]["PolylineBody"] | components["schemas"]["ClassificationBody"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Label Class */
            label_class: string;
            /** Model Ref */
            model_ref?: string | null;
            /**
             * Provenance
             * @enum {string}
             */
            provenance: "human" | "model" | "import";
        };
        /**
         * AssetAction
         * @description What can be asked of one asset inside a batch.
         *
         *     ``ANNOTATE`` is the odd one and the important one: it is not a progress move
         *     but the right to write labels at all, which is ``WRITABLE_PROGRESS`` and the
         *     batch gate together. The other five each name one edge of
         *     ``ASSET_PROGRESS_TRANSITIONS`` — see :data:`ASSET_MOVES`.
         * @enum {string}
         */
        AssetAction: "annotate" | "skip" | "restore" | "submit_for_review" | "accept" | "return_to_annotator";
        /**
         * AssetOut
         * @description One ingested item.
         */
        AssetOut: {
            /** Content Hash */
            content_hash: string;
            format: components["schemas"]["ImageFormat"] | null;
            /** Frame Index */
            frame_index: number | null;
            /** Frame Timestamp */
            frame_timestamp: number | null;
            /** Height */
            height: number | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Ingested At */
            ingested_at: string | null;
            /**
             * Modality
             * @constant
             */
            modality: "image";
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
            /** Source Id */
            source_id: string | null;
            /** Thumbnail Hash */
            thumbnail_hash: string | null;
            /** Width */
            width: number | null;
        };
        /**
         * AssetPage
         * @description A page of assets.
         */
        AssetPage: {
            /** Items */
            items: components["schemas"]["AssetOut"][];
            /** Total */
            total: number;
        };
        /**
         * AssetProgress
         * @description Per-asset annotation progress inside a job.
         * @enum {string}
         */
        AssetProgress: "unannotated" | "annotated" | "skipped" | "review_pending" | "accepted";
        /**
         * AssetProgressOut
         * @description Where one asset of a job has got to.
         */
        AssetProgressOut: {
            /**
             * Asset Id
             * Format: uuid
             */
            asset_id: string;
            progress: components["schemas"]["AssetProgress"];
        };
        /**
         * AssetProgressSet
         * @description The state to record for one asset.
         */
        AssetProgressSet: {
            progress: components["schemas"]["AssetProgress"];
        };
        /**
         * AttributeBody
         * @description A typed attribute on a label class.
         */
        AttributeBody: {
            /** Default */
            default?: boolean | number | string | null;
            /**
             * Kind
             * @enum {string}
             */
            kind: "string" | "number" | "boolean" | "select";
            /** Name */
            name: string;
            /** Options */
            options?: string[] | null;
            /**
             * Required
             * @default false
             */
            required: boolean;
        };
        /**
         * BackgroundJobOut
         * @description One unit of background work, and how far it has got.
         */
        BackgroundJobOut: {
            /** Attempt */
            attempt: number;
            /** Cancel Requested */
            cancel_requested: boolean;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Error */
            error: string | null;
            /** Failures */
            failures: components["schemas"]["ItemFailureOut"][];
            /** Finished At */
            finished_at: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Processed */
            processed: number;
            /** Result */
            result: {
                [key: string]: components["schemas"]["JsonValue"];
            };
            /** Started At */
            started_at: string | null;
            state: components["schemas"]["BackgroundJobState"];
            /** Total */
            total: number | null;
            /** Type */
            type: string;
        };
        /**
         * BackgroundJobPage
         * @description A page of background jobs.
         */
        BackgroundJobPage: {
            /** Items */
            items: components["schemas"]["BackgroundJobOut"][];
            /** Total */
            total: number;
        };
        /**
         * BackgroundJobState
         * @description Lifecycle: queued -> running -> (succeeded | failed | cancelled).
         *
         *     Five states rather than four. ``cancelled`` is not a flavour of ``failed``
         *     because the two answer different questions for the person reading a list:
         *     a failure is something to look into, a cancellation is something somebody
         *     did. Merging them would make "why did this stop?" unanswerable from the row.
         * @enum {string}
         */
        BackgroundJobState: "queued" | "running" | "succeeded" | "failed" | "cancelled";
        /**
         * BatchAction
         * @description What can be asked of a batch. Declaration order is display order.
         * @enum {string}
         */
        BatchAction: "approve" | "start" | "complete" | "repin" | "promote" | "create_correction" | "edit_membership" | "delete";
        /**
         * BatchApprove
         * @description How to cut the batch into jobs. One job for the whole batch by default.
         */
        BatchApprove: {
            /** Partition */
            partition?: (components["schemas"]["SingleJobBody"] | components["schemas"]["BySizeBody"] | components["schemas"]["BySegmentsBody"]) | null;
        };
        /**
         * BatchAssetOut
         * @description One item of a batch, with the job that carries it and where it has got to.
         */
        BatchAssetOut: {
            /** Allowed Actions */
            allowed_actions: components["schemas"]["AssetAction"][];
            /** Content Hash */
            content_hash: string;
            format: components["schemas"]["ImageFormat"] | null;
            /** Frame Index */
            frame_index: number | null;
            /** Frame Timestamp */
            frame_timestamp: number | null;
            /** Height */
            height: number | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Ingested At */
            ingested_at: string | null;
            /** Job Id */
            job_id: string | null;
            /**
             * Modality
             * @constant
             */
            modality: "image";
            progress: components["schemas"]["AssetProgress"] | null;
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
            /** Source Id */
            source_id: string | null;
            /** Thumbnail Hash */
            thumbnail_hash: string | null;
            /** Width */
            width: number | null;
        };
        /**
         * BatchAssetPage
         * @description A page of the assets in a batch.
         */
        BatchAssetPage: {
            /** Items */
            items: components["schemas"]["BatchAssetOut"][];
            /** Total */
            total: number;
        };
        /**
         * BatchCorrection
         * @description A correction of a completed batch: a name, and optionally a subset.
         */
        BatchCorrection: {
            /** Asset Ids */
            asset_ids?: string[];
            /** Name */
            name: string;
        };
        /**
         * BatchCreate
         * @description A new draft batch: a name, and the assets to start it with.
         */
        BatchCreate: {
            /** Asset Ids */
            asset_ids?: string[];
            /** Name */
            name: string;
        };
        /**
         * BatchMembership
         * @description Which assets to put in, or take out of, a draft batch.
         */
        BatchMembership: {
            /** Asset Ids */
            asset_ids: string[];
        };
        /**
         * BatchMembershipOut
         * @description A membership edit's outcome: the batch afterwards, and what actually moved.
         */
        BatchMembershipOut: {
            batch: components["schemas"]["BatchOut"];
            /** Changed */
            changed: string[];
        };
        /**
         * BatchOut
         * @description A curated slice of a project's assets that moves through annotation together.
         */
        BatchOut: {
            /** Allowed Actions */
            allowed_actions: components["schemas"]["BatchAction"][];
            /** Asset Count */
            asset_count: number;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Name */
            name: string;
            /** Parent Batch Id */
            parent_batch_id: string | null;
            progress: components["schemas"]["ProgressCounts"];
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
            /** Promoted Asset Count */
            promoted_asset_count: number;
            /** Schema Version */
            schema_version: number | null;
            state: components["schemas"]["BatchState"];
        };
        /**
         * BatchPage
         * @description A page of batches.
         */
        BatchPage: {
            /** Items */
            items: components["schemas"]["BatchOut"][];
            /** Total */
            total: number;
        };
        /**
         * BatchState
         * @description Lifecycle: draft -> approved -> in_annotation -> completed.
         *
         *     Membership is editable in ``draft`` and nowhere else: approval freezes the
         *     batch, pins its schema version and cuts it into jobs. ``BatchService`` owns
         *     the moves; ``BATCH_TRANSITIONS`` below is the whole of what is legal.
         * @enum {string}
         */
        BatchState: "draft" | "approved" | "in_annotation" | "completed";
        /**
         * BboxBody
         * @description An axis-aligned rectangle: top-left corner plus size, in asset pixels.
         */
        BboxBody: {
            /** Height */
            height: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "bbox";
            /** Width */
            width: number;
            /** X */
            x: number;
            /** Y */
            y: number;
        };
        /** Body_register_image_source */
        Body_register_image_source: {
            /**
             * Files
             * @description The images, as one multipart part each.
             */
            files: string[];
            /**
             * Name
             * @description What to call the source. Without one it is named by its staged directory, whose basename is a content digest — 64 hex characters nobody can read. Registering the same files again with a new name renames the existing source rather than creating a second one.
             */
            name?: string | null;
        };
        /** Body_register_video_source */
        Body_register_video_source: {
            /**
             * Extraction Fps
             * @description Frames per second to cut the clip at. One per second by default.
             * @default 1
             */
            extraction_fps: number;
            /**
             * File
             * @description The clip.
             */
            file: string;
        };
        /**
         * BySegmentsBody
         * @description Exactly these segments, which must reproduce the batch with nothing over.
         */
        BySegmentsBody: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "by_segments";
            /** Segments */
            segments: string[][];
        };
        /**
         * BySizeBody
         * @description Jobs of a fixed number of assets each; the last one takes the remainder.
         */
        BySizeBody: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "by_size";
            /** Size */
            size: number;
        };
        /**
         * ChangeKind
         * @description Whether a change preserves the meaning of existing annotations.
         * @enum {string}
         */
        ChangeKind: "additive" | "destructive";
        /**
         * ClassCompatibilityOut
         * @description One class of a release, judged against one format's capabilities.
         */
        ClassCompatibilityOut: {
            /** Annotations */
            annotations: number;
            /** Assets */
            assets: number;
            geometry: components["schemas"]["GeometryType"];
            /** Label Class */
            label_class: string;
            /** Reason */
            reason?: string | null;
            status: components["schemas"]["ClassExportStatus"];
        };
        /**
         * ClassCountOut
         * @description How much of one label class the trunk holds.
         */
        ClassCountOut: {
            /** Annotations */
            annotations: number;
            /** Assets */
            assets: number;
            /** Label Class */
            label_class: string;
        };
        /**
         * ClassExportStatus
         * @description What one format does with one class: writes it, reduces it, or drops it.
         * @enum {string}
         */
        ClassExportStatus: "supported" | "degraded" | "dropped";
        /**
         * ClassificationBody
         * @description A whole-asset tag: a class with no coordinates.
         */
        ClassificationBody: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "classification_tag";
        };
        /**
         * ConnectionAction
         * @description What can be asked of an inference connection. Order is display order.
         *
         *     Two, and the omissions are the point. ``download_weights`` and ``test`` are
         *     the actions this resource will eventually be asked for, and neither is named
         *     here yet because neither has anything behind it — under the
         *     ``ui-capabilities`` contract a declared action obliges every client to offer
         *     it, so naming one before its surface exists is how a wire becomes the source
         *     of a control that cannot work. #376 is the precedent: the name returns in the
         *     same change as the route that honours it.
         * @enum {string}
         */
        ConnectionAction: "update" | "delete";
        /**
         * ConnectionCreate
         * @description What a caller supplies to configure a connection.
         *
         *     ``setup_state`` is absent on purpose: it is derived from the kind by the
         *     service, because it says what the kind still needs rather than what the
         *     caller wants. Accepting it would let a client declare weights present that
         *     were never fetched.
         */
        ConnectionCreate: {
            connection_type: components["schemas"]["ConnectionType"];
            /** Device */
            device?: string | null;
            /** Endpoint Url */
            endpoint_url?: string | null;
            /** Model Id */
            model_id: string;
            /** Model Revision */
            model_revision: string;
            /** Name */
            name: string;
            /** Precision */
            precision?: string | null;
        };
        /**
         * ConnectionOut
         * @description One configured place a model can be asked to predict.
         */
        ConnectionOut: {
            /** Allowed Actions */
            allowed_actions: components["schemas"]["ConnectionAction"][];
            connection_type: components["schemas"]["ConnectionType"];
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Device */
            device: string | null;
            /** Endpoint Url */
            endpoint_url: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Model Id */
            model_id: string;
            /** Model Revision */
            model_revision: string;
            /** Name */
            name: string;
            /** Precision */
            precision: string | null;
            setup_state: components["schemas"]["ConnectionSetupState"];
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /**
         * ConnectionPage
         * @description A page of inference connections.
         */
        ConnectionPage: {
            /** Items */
            items: components["schemas"]["ConnectionOut"][];
            /** Total */
            total: number;
        };
        /**
         * ConnectionSetupState
         * @description Whether a connection is ready to be asked for a prediction.
         *
         *     ``not_set_up`` means something local is still missing — weights that were
         *     never fetched. It is the state a ``local`` connection is born in, and the one
         *     a download clears.
         *
         *     Deliberately **not** a reachability answer. Whether an endpoint responds is a
         *     question with a fresh answer every time it is asked, so it belongs to a test
         *     call and its result, never to a stored row that would start lying the moment
         *     the network moved.
         * @enum {string}
         */
        ConnectionSetupState: "not_set_up" | "ready";
        /**
         * ConnectionType
         * @description Where a connection's model runs.
         *
         *     A ``StrEnum`` rather than a plain ``str`` on ``SourceKind``'s test: nothing
         *     outside this build writes the value, the kernel branches on it, and the set
         *     grows only by a deliberate kernel change — a hosted connection type arriving
         *     later is exactly that change.
         * @enum {string}
         */
        ConnectionType: "local" | "http";
        /**
         * ConnectionUpdate
         * @description A partial edit. Every field omitted or null means *leave this alone*.
         *
         *     ``connection_type`` is absent because the kind is not editable — see
         *     ``InferenceConnectionService.update``. A field cannot be *cleared* through
         *     this shape, which is the honest consequence of null meaning "unchanged": the
         *     parameters that could be cleared are exactly the ones the kind requires, so
         *     clearing one would produce a row the domain refuses anyway.
         */
        ConnectionUpdate: {
            /** Device */
            device?: string | null;
            /** Endpoint Url */
            endpoint_url?: string | null;
            /** Model Id */
            model_id?: string | null;
            /** Model Revision */
            model_revision?: string | null;
            /** Name */
            name?: string | null;
            /** Precision */
            precision?: string | null;
        };
        /**
         * DatasetChangeOut
         * @description One entry in the trunk's append-only log.
         */
        DatasetChangeOut: {
            /** Actor */
            actor: string | null;
            /**
             * Dataset Id
             * Format: uuid
             */
            dataset_id: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Occurred At
             * Format: date-time
             */
            occurred_at: string;
            /** Operation */
            operation: string;
            /** Subject Ids */
            subject_ids: string[];
        };
        /**
         * DatasetChangePage
         * @description A page of change-log entries.
         */
        DatasetChangePage: {
            /** Items */
            items: components["schemas"]["DatasetChangeOut"][];
            /** Total */
            total: number;
        };
        /**
         * DatasetOut
         * @description A project's curated trunk of training data.
         */
        DatasetOut: {
            /** Description */
            description: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Name */
            name: string;
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
        };
        /**
         * DatasetStatsOut
         * @description What the trunk currently holds, counted.
         */
        DatasetStatsOut: {
            /** Annotated Asset Count */
            annotated_asset_count: number;
            /** Annotation Count */
            annotation_count: number;
            /** Asset Count */
            asset_count: number;
            /** Classes */
            classes: components["schemas"]["ClassCountOut"][];
            /**
             * Dataset Id
             * Format: uuid
             */
            dataset_id: string;
        };
        /**
         * ErrorBody
         * @description The one error shape this API emits, at every status.
         */
        ErrorBody: {
            /**
             * Code
             * @description Stable machine-readable code. Branch on this, not on the status.
             */
            code: string;
            /**
             * Detail
             * @description Extra structure whose shape depends on the code; absent when there is none.
             */
            detail?: {
                [key: string]: unknown;
            } | null;
            /**
             * Message
             * @description Human-readable sentence. Wording is not part of the contract.
             */
            message: string;
        };
        /**
         * ExportCompatibilityOut
         * @description What one format would drop from one release, worked out before writing.
         */
        ExportCompatibilityOut: {
            /** Classes */
            classes: components["schemas"]["ClassCompatibilityOut"][];
            /** Compatible */
            compatible: boolean;
            /** Degraded Annotations */
            degraded_annotations: number;
            /** Degraded Assets */
            degraded_assets: number;
            /** Excluded Annotations */
            excluded_annotations: number;
            /** Excluded Assets */
            excluded_assets: number;
            /** Format */
            format: string;
            /** Format Is Lossy */
            format_is_lossy: boolean;
            /**
             * Release Id
             * Format: uuid
             */
            release_id: string;
        };
        /**
         * FormatOut
         * @description An installed export format, and what it can express.
         */
        FormatOut: {
            /**
             * Degraded Geometries
             * @default []
             */
            degraded_geometries: string[];
            /**
             * Geometries
             * @default []
             */
            geometries: string[];
            /** Lossy */
            lossy: boolean;
            /**
             * Modalities
             * @default []
             */
            modalities: string[];
            /** Name */
            name: string;
        };
        /**
         * FormatPage
         * @description A page of export formats.
         */
        FormatPage: {
            /** Items */
            items: components["schemas"]["FormatOut"][];
            /** Total */
            total: number;
        };
        /**
         * GeometryType
         * @description Every geometry the domain can address.
         *
         *     3D values exist today even though unimplemented: the domain never assumes
         *     "image" anywhere — that is the Physical AI roadmap encoded as a type.
         * @enum {string}
         */
        GeometryType: "bbox" | "polygon" | "mask" | "polyline" | "keypoints" | "cuboid_3d" | "polyline_3d" | "classification_tag";
        /**
         * ImageFormat
         * @description Every still-image encoding VisionSet accepts. See the module docstring.
         *
         *     A ``StrEnum`` rather than a ``Literal``, unlike ``Asset.modality``: that one
         *     has a single member, where an enum would be ceremony, and this one is a
         *     closed set whose whole purpose is to grow deliberately. It costs the
         *     persistence layer nothing — a ``StrEnum`` member *is* a ``str``, and the
         *     tables already store every other enum as ``String``.
         * @enum {string}
         */
        ImageFormat: "jpeg" | "png";
        /**
         * IngestFailureKind
         * @description Why one item did not become an asset, split by what to do about it.
         *
         *     An enum rather than a plain ``str``, on exactly ``SourceKind``'s terms: the
         *     set is closed, no writer outside this build produces a value, and the kernel
         *     branches on it. What makes it worth a type at all is that a report has to be
         *     **grouped**, not read — ``CorruptMedia``'s docstring is explicit that a
         *     report unable to separate the two would bury real data loss under ordinary
         *     operator noise, and a reason sentence cannot be grouped on.
         * @enum {string}
         */
        IngestFailureKind: "unsupported" | "corrupt";
        /**
         * IngestFailureOut
         * @description One item a run could not read, and why.
         */
        IngestFailureOut: {
            kind: components["schemas"]["IngestFailureKind"];
            /** Name */
            name: string;
            /** Reason */
            reason: string;
        };
        /**
         * IngestJobOut
         * @description One run of one source, and how far it has got.
         */
        IngestJobOut: {
            /** Batch Id */
            batch_id: string | null;
            /** Batch Name */
            batch_name: string | null;
            /** Error */
            error: string | null;
            /** Failures */
            failures: components["schemas"]["IngestFailureOut"][];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Processed */
            processed: number;
            /**
             * Source Id
             * Format: uuid
             */
            source_id: string;
            state: components["schemas"]["IngestState"];
            /** Total */
            total: number | null;
        };
        /**
         * IngestJobPage
         * @description A page of ingest jobs.
         */
        IngestJobPage: {
            /** Items */
            items: components["schemas"]["IngestJobOut"][];
            /** Total */
            total: number;
        };
        /**
         * IngestStart
         * @description What launching a run needs, which is almost nothing.
         */
        IngestStart: {
            /** Batch Id */
            batch_id?: string | null;
            /** Batch Name */
            batch_name?: string | null;
        };
        /**
         * IngestState
         * @description Lifecycle: pending -> running -> (completed | failed) -> running.
         *
         *     ``IngestService`` owns the moves; ``INGEST_TRANSITIONS`` below is the whole
         *     of what is legal.
         * @enum {string}
         */
        IngestState: "pending" | "running" | "completed" | "failed";
        /**
         * ItemFailureOut
         * @description One item a job could not process, and why.
         */
        ItemFailureOut: {
            /** Name */
            name: string;
            /** Reason */
            reason: string;
        };
        /**
         * JobAction
         * @description What can be asked of an annotation job.
         * @enum {string}
         */
        JobAction: "start" | "complete";
        /**
         * JobOut
         * @description One annotator's unit of work over a segment of a batch.
         */
        JobOut: {
            /** Allowed Actions */
            allowed_actions: components["schemas"]["JobAction"][];
            /** Asset Count */
            asset_count: number;
            /**
             * Batch Id
             * Format: uuid
             */
            batch_id: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            state: components["schemas"]["AnnotationJobState"];
        };
        /**
         * JobPage
         * @description A page of annotation jobs.
         */
        JobPage: {
            /** Items */
            items: components["schemas"]["JobOut"][];
            /** Total */
            total: number;
        };
        JsonValue: unknown;
        /**
         * LabelClassBody
         * @description One labelable class, bound to a geometry.
         */
        LabelClassBody: {
            /**
             * Attributes
             * @default []
             */
            attributes: components["schemas"]["AttributeBody"][];
            /** Color */
            color?: string | null;
            geometry: components["schemas"]["GeometryType"];
            /** Name */
            name: string;
        };
        /**
         * PolygonBody
         * @description A closed polygon of at least three points. The closing edge is implicit.
         */
        PolygonBody: {
            /** Points */
            points: [
                number,
                number
            ][];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "polygon";
        };
        /**
         * PolylineBody
         * @description An open path of at least two points, in order. Nothing joins the ends.
         */
        PolylineBody: {
            /** Points */
            points: [
                number,
                number
            ][];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "polyline";
        };
        /**
         * ProgressCounts
         * @description How many assets sit in each annotation state.
         */
        ProgressCounts: {
            /** Accepted */
            accepted: number;
            /** Annotated */
            annotated: number;
            /** Review Pending */
            review_pending: number;
            /** Skipped */
            skipped: number;
            /** Total */
            total: number;
            /** Unannotated */
            unannotated: number;
        };
        /**
         * ProjectCreate
         * @description What creating a project needs.
         */
        ProjectCreate: {
            /** Description */
            description?: string | null;
            /** Name */
            name: string;
        };
        /**
         * ProjectOut
         * @description A project.
         */
        ProjectOut: {
            /** Description */
            description: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Name */
            name: string;
        };
        /**
         * ProjectPage
         * @description A page of projects.
         */
        ProjectPage: {
            /** Items */
            items: components["schemas"]["ProjectOut"][];
            /** Total */
            total: number;
        };
        /**
         * ProjectRename
         * @description The one field of a project that moves.
         */
        ProjectRename: {
            /** Name */
            name: string;
        };
        /**
         * ProjectStatsOut
         * @description What the project holds, counted — everything ingested, not only the trunk.
         */
        ProjectStatsOut: {
            /** Annotated Asset Count */
            annotated_asset_count: number;
            /** Annotated Pct */
            annotated_pct: number;
            /** Annotation Count */
            annotation_count: number;
            /** Asset Count */
            asset_count: number;
            /** Class Count */
            class_count: number;
            /** Classes */
            classes: components["schemas"]["ClassCountOut"][];
            /**
             * Last Ingest At
             * @description Timestamp of the most recent asset ingest. Null when unknown (assets ingested before v0.1.0).
             */
            last_ingest_at?: string | null;
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
        };
        /**
         * ReleaseCreate
         * @description What publishing a release needs.
         */
        ReleaseCreate: {
            split?: components["schemas"]["SplitRecipeBody"] | null;
            /** Tag */
            tag: string;
        };
        /**
         * ReleaseOut
         * @description An immutable, exportable snapshot of a dataset.
         */
        ReleaseOut: {
            /** Annotation Count */
            annotation_count: number;
            /** Asset Count */
            asset_count: number;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Dataset Id
             * Format: uuid
             */
            dataset_id: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Manifest Hash */
            manifest_hash: string;
            /** Schema Version */
            schema_version: number;
            split: components["schemas"]["SplitRecipeBody"] | null;
            /** Tag */
            tag: string;
            /** Visionset Version */
            visionset_version: string;
        };
        /**
         * ReleasePage
         * @description A page of releases.
         */
        ReleasePage: {
            /** Items */
            items: components["schemas"]["ReleaseOut"][];
            /** Total */
            total: number;
        };
        /**
         * ReleaseVerificationOut
         * @description What re-hashing everything a release names turned up.
         */
        ReleaseVerificationOut: {
            /** Cache Mismatches */
            cache_mismatches: string[];
            /** Checked */
            checked: number;
            /** Corrupt */
            corrupt: string[];
            /** Manifest Hash */
            manifest_hash: string;
            /** Manifest Intact */
            manifest_intact: boolean;
            /** Missing */
            missing: string[];
            /** Ok */
            ok: boolean;
            /**
             * Release Id
             * Format: uuid
             */
            release_id: string;
        };
        /**
         * SchemaChangeOut
         * @description One difference between two schema versions, already judged.
         */
        SchemaChangeOut: {
            /** Attribute */
            attribute: string | null;
            /** Detail */
            detail: string;
            kind: components["schemas"]["ChangeKind"];
            /** Label Class */
            label_class: string;
        };
        /**
         * SchemaDiffOut
         * @description Every difference between two schema versions, and the verdict on them.
         */
        SchemaDiffOut: {
            /** Changes */
            changes: components["schemas"]["SchemaChangeOut"][];
            /** Destructive Classes */
            destructive_classes: string[];
            /** Is Destructive */
            is_destructive: boolean;
        };
        /**
         * SchemaProvenance
         * @description Which kind of work published a schema version.
         *
         *     `curated` is a version authored deliberately — somebody sat down and decided
         *     what the project labels. `annotation` is one that fell out of adding a class
         *     part-way through labeling an asset. It gates nothing and is part of no
         *     contract comparison; a version history uses it to tell the milestones apart
         *     from the incidental runs between them.
         * @enum {string}
         */
        SchemaProvenance: "curated" | "annotation";
        /**
         * SchemaVersionCreate
         * @description The whole proposed version. There is no partial edit of a schema.
         */
        SchemaVersionCreate: {
            /**
             * Classes
             * @default []
             */
            classes: components["schemas"]["LabelClassBody"][];
            /** Description */
            description?: string | null;
            provenance?: components["schemas"]["SchemaProvenance"] | null;
        };
        /**
         * SchemaVersionOut
         * @description One version of a project's labeling contract.
         */
        SchemaVersionOut: {
            /** Classes */
            classes: components["schemas"]["LabelClassBody"][];
            /** Created At */
            created_at?: string | null;
            /** Description */
            description?: string | null;
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
            provenance?: components["schemas"]["SchemaProvenance"] | null;
            /** Version */
            version: number;
        };
        /**
         * SchemaVersionPage
         * @description A page of schema versions.
         */
        SchemaVersionPage: {
            /** Items */
            items: components["schemas"]["SchemaVersionOut"][];
            /** Total */
            total: number;
        };
        /**
         * SingleJobBody
         * @description One job for the whole batch.
         */
        SingleJobBody: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "single";
        };
        /**
         * SourceKind
         * @description The shapes of raw input VisionSet accepts.
         *
         *     An enum, where ``DatasetChange.operation`` and ``VideoMetadata.codec`` are
         *     plain ``str``. That doctrine turns on one question — *can something outside
         *     this build write the value?* A change-log entry outlives the release that
         *     wrote it and a codec name is whatever ffmpeg decides to call it, so both have
         *     to stay readable when they name something this build never heard of.
         *
         *     Neither applies here. ``SourceService`` is the only door to a ``Source``, so
         *     no foreign writer exists; the kernel **branches** on this value, in the two
         *     registration methods and in the invariant tying :attr:`Source.video` to
         *     :attr:`SourceKind.VIDEO`, and a branch on a magic string is the shape this
         *     codebase replaces with a table; and the set grows by a deliberate kernel
         *     change with a service method behind it. That is ``ImageFormat`` /
         *     ``BatchState`` / ``IngestState`` territory, and it costs persistence nothing
         *     — a ``StrEnum`` member *is* a ``str``.
         * @enum {string}
         */
        SourceKind: "image_directory" | "video";
        /**
         * SourceOut
         * @description A registered origin: a folder of stills, or a clip.
         */
        SourceOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            kind: components["schemas"]["SourceKind"];
            /** Name */
            name: string;
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
            /**
             * Registered At
             * Format: date-time
             */
            registered_at: string;
            video: components["schemas"]["VideoProvenanceOut"] | null;
        };
        /**
         * SourcePage
         * @description A page of sources.
         */
        SourcePage: {
            /** Items */
            items: components["schemas"]["SourceOut"][];
            /** Total */
            total: number;
        };
        /**
         * SplitAssignmentOut
         * @description The folds a release's recipe produces over its frozen asset set.
         */
        SplitAssignmentOut: {
            /** Test */
            test: string[];
            /** Train */
            train: string[];
            /** Val */
            val: string[];
        };
        /**
         * SplitRecipeBody
         * @description Train/val/test fractions and the seed that makes the cut reproducible.
         */
        SplitRecipeBody: {
            /**
             * Seed
             * @default 0
             */
            seed: number;
            /** Test */
            test: number;
            /** Train */
            train: number;
            /** Val */
            val: number;
        };
        /**
         * VideoProvenanceOut
         * @description What a clip turned out to be, and the rate it is decomposed at.
         */
        VideoProvenanceOut: {
            /** Codec */
            codec: string;
            /** Duration Seconds */
            duration_seconds: number;
            /** Extraction Fps */
            extraction_fps: number;
            /** Fps */
            fps: number;
            /** Height */
            height: number;
            /** Width */
            width: number;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    list_background_jobs: {
        parameters: {
            query?: {
                /** @description Only jobs in these states. Repeat the parameter for several. Omitted, every job is returned. */
                state?: components["schemas"]["BackgroundJobState"][] | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BackgroundJobPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_background_job: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BackgroundJobOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_background_job_artifact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The file the job produced. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": unknown;
                    "application/zip": unknown;
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    cancel_background_job: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BackgroundJobOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_batch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    delete_batch: {
        parameters: {
            query?: {
                /** @description Required to destroy data. The kernel refuses the request without it. */
                confirm?: boolean;
            };
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    approve_batch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["BatchApprove"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_batch_assets: {
        parameters: {
            query?: {
                /** @description How many items to return. Everything from `offset` on by default. */
                limit?: number | null;
                /** @description How many items to skip. Counts from the start of the collection. */
                offset?: number;
            };
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchAssetPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    add_batch_assets: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchMembership"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchMembershipOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    remove_batch_assets: {
        parameters: {
            query: {
                /** @description An asset to remove from the batch. Repeat the parameter per id. */
                id: string[];
            };
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchMembershipOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    complete_batch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    create_correction_batch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchCorrection"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_batch_jobs: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    promote_batch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssetPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    repin_batch: {
        parameters: {
            query?: {
                allow_destructive?: boolean;
            };
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    start_batch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                batch_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_dataset: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                dataset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DatasetOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_dataset_assets: {
        parameters: {
            query?: {
                /** @description How many items to return. Everything from `offset` on by default. */
                limit?: number | null;
                /** @description How many items to skip. Counts from the start of the collection. */
                offset?: number;
            };
            header?: never;
            path: {
                dataset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssetPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    remove_dataset_asset: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                dataset_id: string;
                asset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_dataset_changes: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                dataset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DatasetChangePage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_releases: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                dataset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleasePage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    publish_release: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                dataset_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReleaseCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    dataset_stats: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                dataset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DatasetStatsOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_formats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FormatPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    health: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: string;
                    };
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_inference_connections: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    create_inference_connection: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_inference_connection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                connection_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    delete_inference_connection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                connection_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    update_inference_connection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                connection_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectionOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_ingest_job: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IngestJobOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    resume_ingest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IngestJobOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_job: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    add_annotations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AnnotationCreate"][];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AnnotationPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    delete_annotations: {
        parameters: {
            query: {
                /** @description An annotation to delete. Repeat the parameter per id. */
                id: string[];
            };
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    update_annotations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AnnotationUpdate"][];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AnnotationPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_asset_annotations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
                asset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AnnotationPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    set_asset_progress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
                asset_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AssetProgressSet"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssetProgressOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    complete_job: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    next_pending_assets: {
        parameters: {
            query?: {
                /** @description How many waiting assets to hand out. Fewer if fewer remain. */
                n?: number;
            };
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssetPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_job_progress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProgressCounts"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    start_job: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_projects: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    create_project: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_project: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    delete_project: {
        parameters: {
            query?: {
                /** @description Required to destroy data. The kernel refuses the request without it. */
                confirm?: boolean;
            };
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    rename_project: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectRename"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_project_assets: {
        parameters: {
            query?: {
                /** @description How many items to return. Everything from `offset` on by default. */
                limit?: number | null;
                /** @description How many items to skip. Counts from the start of the collection. */
                offset?: number;
            };
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssetPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_asset: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                asset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssetOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_asset_batches: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                asset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_asset_content: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                asset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The bytes, streamed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": unknown;
                    "image/jpeg": unknown;
                    "image/png": unknown;
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_asset_thumbnail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                asset_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The cached preview, streamed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/jpeg": unknown;
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_batches: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    create_batch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BatchCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BatchOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_project_dataset: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DatasetOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_active_schema: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SchemaVersionOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    compare_schema_versions: {
        parameters: {
            query: {
                /** @description The version to compare *from*, 1..N. */
                from: number;
                /** @description The version to compare *to*, 1..N. */
                to: number;
            };
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SchemaDiffOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_schema_versions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SchemaVersionPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    create_schema_version: {
        parameters: {
            query?: {
                /** @description Required when the new version narrows the labeling contract. */
                allow_destructive?: boolean;
            };
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SchemaVersionCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SchemaVersionOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_schema_version: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                /** @description A schema version, 1..N. */
                version: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SchemaVersionOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_sources: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourcePage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    register_image_source: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_register_image_source"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    register_video_source: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_register_video_source"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_project_stats: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectStatsOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_release: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                release_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_release_assignment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                release_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SplitAssignmentOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    export_release: {
        parameters: {
            query: {
                /** @description Which installed format to write. `GET /formats` lists them. */
                format: string;
                /** @description Required when the format cannot carry everything the release holds. */
                allow_lossy?: boolean;
            };
            header?: never;
            path: {
                release_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BackgroundJobOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    check_export: {
        parameters: {
            query: {
                /** @description Which installed format to write. `GET /formats` lists them. */
                format: string;
            };
            header?: never;
            path: {
                release_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportCompatibilityOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_release_manifest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                release_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The canonical manifest document, byte for byte. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    verify_release: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                release_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseVerificationOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    get_source: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                source_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    list_ingest_jobs: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                source_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IngestJobPage"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    start_ingest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                source_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["IngestStart"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IngestJobOut"];
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description No such resource */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource's state refuses this request */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request payload is not processable */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description Unhandled server error, with an incident id */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace is busy; retry after the header says */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
}
