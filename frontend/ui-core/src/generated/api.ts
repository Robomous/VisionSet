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
         *     caller — the rule `docs/content/api.md` states for every collection here.
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
         *     A job this workspace does not hold is 404 `BACKGROUND_JOB_NOT_FOUND`. There
         *     is a 404 for the artifact too — the job never produced one, or the file is
         *     gone, since an export directory is not garbage-collected but a workspace is a
         *     directory somebody can tidy — and a 409 while the job has not succeeded,
         *     because "not yet" and "never" are different answers and only one of them is
         *     worth retrying. Those last two carry the status's own name rather than a
         *     domain code: nothing about them is a state of the job that a client could
         *     branch on.
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
         *     pin, and an unknown batch is 404 `BATCH_NOT_FOUND`.
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
         * @description The batch's assets, with where each has got to and its labels in two numbers.
         *
         *     Membership order by default, so reading twice gives the same sequence and an
         *     ingest into an existing batch appends rather than reshuffles; `sort=confidence`
         *     puts the frame whose weakest model label scores lowest first, unscored frames
         *     last, ties in membership order. `progress` narrows to the states named, and
         *     `total` is the size of what matched — the whole batch when nothing narrows it.
         *     An offset past the end is an empty list and a 200, never a 404. The 404 belongs
         *     to the batch itself, which is resolved first: an unknown one is `BATCH_NOT_FOUND`.
         *
         *     `job_id` and `progress` are null while the batch is a draft, because a draft
         *     has no jobs — so a `progress` filter over a draft matches nothing. Bytes are
         *     not here: an asset is named by its hashes, and
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
         *     annotation writes are all-or-nothing. An unknown batch is 404
         *     `BATCH_NOT_FOUND`, resolved before any id is read.
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
         *
         *     A batch that is not `in_annotation` has no closing move to make and is 409
         *     `INVALID_TRANSITION` — the same one-way table that leaves `completed` with no
         *     exit at all, which is why correcting settled work is a new batch.
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
         *     `completed`, and 409 `INVALID_TRANSITION` is what a client gets for asking
         *     otherwise.
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
    "/batches/{batch_id}/pre-label": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Pre Label Plan
         * @description The classes a run would ask this connection's model for, and the shapes it would write.
         *
         *     A run's prompt is the batch's pinned schema narrowed to the classes the
         *     model can answer — a class is asked for when it admits a shape the model
         *     produces and demands no attribute a prediction cannot supply — and that
         *     narrowing is invisible once the run has finished. Read this before
         *     launching to say which classes are in the prompt and which are not, with
         *     the reason beside each, and which shapes a run will write: `produces` is
         *     the model's declared shapes, so a schema of polygon classes is askable of a
         *     model that answers polygons and refused for one that answers boxes.
         *
         *     `connection_id` is required because the plan is a property of the schema
         *     **and** the model: the same schema yields a different prompt for a detector
         *     and for a segmenter.
         *
         *     Refused on the same terms the launch uses, in the same order, so reading
         *     the plan and then launching gets one set of answers: an unknown connection
         *     is 404 `INFERENCE_CONNECTION_NOT_FOUND`; a connection not set up yet is 409
         *     `INFERENCE_CONNECTION_NOT_SET_UP`; one whose model answers places rather
         *     than words is 422 `UNSUPPORTED_PROMPT`; an unknown batch is 404
         *     `BATCH_NOT_FOUND`; a batch that is not `in_annotation` is 409
         *     `BATCH_NOT_IN_ANNOTATION`; a pinned schema with no class the model's shapes
         *     can be written as is 409 `SCHEMA_HAS_NO_DETECTABLE_CLASS`. A machine
         *     without the optional local runtime answers 500 `LOCAL_INFERENCE_UNAVAILABLE`
         *     with the install command, and a batch open for annotation but pinning no
         *     schema version is a broken invariant and answers 500 `WORKSPACE_CORRUPT`.
         */
        get: operations["pre_label_plan"];
        put?: never;
        /**
         * Pre Label Batch
         * @description Ask a model to label every untouched asset in this batch, and answer at once.
         *
         *     The `pre_label` action. Labels land at `pre_labeled`, never at `annotated`:
         *     nobody judged them, so they arrive editable and correctable rather than
         *     claiming to be somebody's work — and, being unjudged, they never reach the
         *     Dataset until a person has taken them over.
         *
         *     **Only assets nothing has touched — which is stronger than reading
         *     `unannotated`.** An asset already `pre_labeled`, annotated, skipped,
         *     awaiting review or accepted is passed over, and so is an `unannotated` one
         *     that still carries annotations from an earlier round that was skipped and
         *     then restored: that sequence deletes no labels, so progress alone does not
         *     prove an asset untouched. A run never writes over what a person did in this
         *     batch, and never writes twice over what a model did — a plain second run
         *     extends an earlier one onto whatever is still untouched.
         *     `replace_model_labels` widens it to every frame still `pre_labeled` and
         *     supersedes those labels with this run's answer, one frame per transaction;
         *     a frame anyone edited, confirmed or skipped in this batch is never touched,
         *     and a frame the model now finds nothing on returns to `unannotated`. A
         *     replacing request arriving while a run is in flight joins that run,
         *     whichever flag it carries.
         *
         *     **The batch's pinned schema is the prompt, narrowed to what this model
         *     writes.** The model is asked for each class the schema declares that admits
         *     one of the model's declared shapes and demands no attribute a prediction
         *     cannot supply; an answer naming one of those classes, matched
         *     case-insensitively, is written under the schema's own spelling, and an
         *     answer naming none of them is discarded. A schema with no such class has
         *     nowhere for a prediction to land and is refused — so the same schema is
         *     askable of a model that answers polygons and refused for one that answers
         *     boxes. `GET` this path with the same `connection_id` to read the narrowing
         *     before launching.
         *
         *     **202, not 200.** A batch is hundreds of forward passes, so this follows the
         *     launch-and-poll contract the export and weight-download routes use: poll `GET
         *     /background-jobs/{id}` — the `Location` header names it — until `state` is
         *     `succeeded`, then re-read the batch's assets. Progress on the row is counted
         *     in assets.
         *
         *     **Everything a caller can be told now is told now**, and no refusal creates a
         *     job — so a caller holding a job id holds one that will run. These refusals
         *     are about the request, and the caller can act on each. They are checked in
         *     this order, and it is the order `pre_label` itself checks in, so a request
         *     wrong about the connection and the batch both always names the connection:
         *     a connection not set up yet is 409 `INFERENCE_CONNECTION_NOT_SET_UP` — its
         *     weights not here, or its endpoint not yet asked what it answers; a
         *     connection whose model answers places rather than words is 422
         *     `UNSUPPORTED_PROMPT`; a batch that is not `in_annotation` is 409
         *     `BATCH_NOT_IN_ANNOTATION`; a pinned schema with no class the model's shapes
         *     can be written as is 409 `SCHEMA_HAS_NO_DETECTABLE_CLASS`.
         *
         *     Two failures are about this installation rather than about the request, and
         *     answer 500 carrying the message that says which: a machine without the
         *     optional local runtime is `LOCAL_INFERENCE_UNAVAILABLE` and carries the
         *     exact command that installs it, and a workspace whose records no longer
         *     hold together — a batch pinned to a schema version that is not stored — is
         *     `WORKSPACE_CORRUPT`. Neither is worth resending unchanged: there is no
         *     state here a caller can change, so the remedy is the one the message names.
         *
         *     **Asking twice joins the run already in flight rather than starting a second
         *     one.** A request arriving while this batch has a pre-labeling run queued or
         *     running is answered with that run's id, so a double-click and a second tab
         *     watch one run instead of paying for the same inference twice.
         */
        post: operations["pre_label_batch"];
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
         *     page; an offset past the end is an empty list and a 200, never a 404. The
         *     404 is the dataset itself: an unknown one is `DATASET_NOT_FOUND`.
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
         *     log records only the calls that actually changed something. The dataset is
         *     the one thing that has to exist: an unknown one is 404 `DATASET_NOT_FOUND`.
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
         *     `SCHEMA_NOT_FOUND`, because there is no version to pin, and an unknown dataset
         *     is 404 `DATASET_NOT_FOUND`.
         *
         *     One refusal is about the labels rather than about the request: an annotation
         *     carrying a coordinate canonical JSON cannot express — a NaN or an infinity —
         *     is 409 `UNSERIALIZABLE_MANIFEST`, and the message names it. Nothing is
         *     published, because writing that value as `null` would lose it silently and
         *     writing it as `NaN` would produce a manifest no other tool can read. The
         *     remedy is to correct the annotation and publish again.
         *
         *     The active schema must also describe every annotation the release would
         *     freeze. Otherwise publishing is 409
         *     `RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA`, with per-class blockers in `detail`.
         *     Reconcile those annotations or restore a compatible active schema, then
         *     publish again.
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
    "/home": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Home
         * @description Everything the workspace's front page shows, in one response.
         *
         *     `totals` counts the whole workspace. `projects` is a short shortcut into the
         *     project list, not a copy of it, and `activity` is capped — both have a screen
         *     that owns them in full.
         *
         *     `resume` is the batch to carry on with, **derived on every call and never
         *     stored**. Read its `kind` first: `annotate` means `next_asset_id` is a frame
         *     nobody has labeled, `review` means it is one awaiting a reviewer, and `open`
         *     means the batch is settled throughout and `next_asset_id` is null — open its
         *     gallery rather than the editor. The three are in priority order, decided
         *     here, and a client renders what it is told rather than working it out again.
         *     `resume` itself is null when no batch is open for annotation.
         *
         *     Batches are ranked by when somebody last worked them. Ones nobody has worked
         *     since that became recordable rank last, ordered among themselves by how far
         *     through they are — which is every batch in a workspace created before the
         *     stamp existed, since it was added without a backfill.
         *
         *     `attention` carries batches with frames awaiting review, and background jobs
         *     that failed or are still running. A job row has no `project_id`: a job names
         *     an ingest run or a release, never a project.
         *
         *     An empty workspace answers zeros, nulls and empty lists. That is the
         *     first-run state, and `totals.projects` is how a client recognises it.
         */
        get: operations["get_home"];
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
         *
         *     Each row carries its most recent weight download **and its most recent
         *     integrity check**, so a client sees a run it did not start — after a reload,
         *     in a second tab, on another machine, or from a terminal. This is therefore the
         *     read a screen polls while either is live, and the reason it can stop polling
         *     the moment neither is.
         *
         *     A set-up connection that has never been asked what kind of model it holds is
         *     asked here, once, from files already on this disk — see
         *     ``visionset.inference.weights.with_families``. It is the backfill for rows
         *     written before a connection recorded that, and it is on the read path because
         *     the kernel cannot reach a model cache and a migration runs in the kernel.
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
         *
         *     Carries the same backfill the listing does, and the same runs, so that reading
         *     one connection and reading the list never disagree about what it can be asked
         *     for or about what is happening to it.
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
         *     than pointing here. What is destroyed is a configuration.
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
    "/inference/connections/{connection_id}/check-integrity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Check Connection Integrity
         * @description Re-read every cached file and compare it against what the hub published.
         *
         *     The `check_integrity` action. Distinct from `download_weights`
         *     over the same files, and the distinction is what each can prove: a download
         *     against a set-up connection establishes that nothing is **missing**, reading
         *     an index rather than the files; this establishes that nothing is
         *     **damaged**, and can only do so by reading every byte.
         *
         *     **202, not 200.** A snapshot is gigabytes and this reads all of it, so it
         *     follows the launch-and-poll contract the download route uses. The run is then
         *     on the connection itself as `integrity_check`, which is what lets a client
         *     that never made this request — after a reload, in another tab, or beside a
         *     terminal that started it — see one in flight and how it ended. `GET
         *     /background-jobs/{id}` answers the same run, and the `Location` header names
         *     it; a successful job's result carries how many files were read and how many
         *     bytes that came to.
         *
         *     **Only for a local connection that is already set up.** An HTTP connection
         *     has no files here and one whose weights never arrived has none to read;
         *     both are 409 `INFERENCE_CONNECTION_NOT_CHECKABLE`, the same answer
         *     `allowed_actions` gave, from the same table. A deployment without the local
         *     runtime is refused here too, with the install command.
         *
         *     **A failed check has already acted.** Damage means the offending files are
         *     purged and the connection is back to `not_set_up` by the time the job row
         *     says so — purged first, because a cache hit is returned unread and a
         *     download over damaged bytes would otherwise hand them straight back. So the
         *     remedy is the `download_weights` the connection now declares, and it is a
         *     real transfer. A check that could not reach the hub changes nothing and
         *     purges nothing: no digests to compare against is an absence of evidence, not
         *     a verdict.
         *
         *     **Asking twice joins the check already running rather than starting a second
         *     one**, the download route's rule and its reason: a request arriving while
         *     this connection has a check queued or running is answered with that run's id,
         *     so nobody pays to read a multi-gigabyte snapshot twice to reach the verdict
         *     already being reached.
         *
         *     **A download running against the same connection does not refuse this**, and
         *     that is deliberate rather than an omission. What a connection declares stays
         *     a function of its setup state and its kind, so no run of either kind changes
         *     what it will accept — see `connection_actions`. The refusal such a rule would
         *     need could only see *jobs*, and this is the only one of the three surfaces
         *     that makes one: the CLI and the MCP tools run the same two operations inline,
         *     with no row to see. So it would bind one caller in three while claiming an
         *     exclusivity none could rely on, and a worker dying mid-job would strand the
         *     connection behind it.
         */
        post: operations["check_connection_integrity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/inference/connections/{connection_id}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Download Connection Weights
         * @description Fetch this connection's weights, and answer at once with the job to poll.
         *
         *     The `download_weights` action, and the only thing in this product that
         *     downloads a model at all. It runs because somebody asked: nothing fetches
         *     weights at install time, at startup, or on the way to anything else.
         *
         *     **202, not 200.** Weights for a detector of this class are gigabytes, so this
         *     follows the launch-and-poll contract the export route uses: poll `GET
         *     /background-jobs/{id}` — the `Location` header names it — until `state` is
         *     `succeeded`, then re-read the connection to see `setup_state` as `ready`.
         *
         *     **Everything a caller can be told now is told now.** A connection that is
         *     already set up, or one whose model runs elsewhere, is 409
         *     `INFERENCE_CONNECTION_NOT_DOWNLOADABLE` on this request — the same answer
         *     `allowed_actions` gave, from the same table. A deployment without the local
         *     runtime installed is refused here too, with the exact install command in the
         *     message. Neither refusal creates a job, so a caller holding a job id holds
         *     one that will run.
         *
         *     The action is declared on a connection whose *state* permits it even where
         *     the runtime is missing, deliberately: whether this machine has the extra is
         *     not a fact about the connection, and hiding the control would leave the
         *     install command with nowhere to be shown.
         *
         *     Re-running is safe. The job verifies a cache it already filled rather than
         *     re-fetching it, and a run that fails leaves the connection exactly as it was
         *     — there is no half-set-up state to recover from.
         *
         *     **Asking twice joins the download already running rather than starting a
         *     second one.** A request that arrives while this connection has a download
         *     queued or running is answered with *that* run's id, so a double-click, a
         *     second tab and a retried request all watch one transfer instead of paying
         *     for the same gigabytes twice. Every answer is still 202 with a `Location`,
         *     and a client polls what it is given either way.
         */
        post: operations["download_connection_weights"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/inference/connections/{connection_id}/test-endpoint": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Test Connection Endpoint
         * @description Ask an `http` connection's endpoint what it answers, and record the answer.
         *
         *     The `test_endpoint` action. One `GET` to the connection's `endpoint_url`,
         *     which answers `{"model_ref": …, "capability": …}` — this project's endpoint
         *     contract. The declared capability becomes the connection's `capabilities`,
         *     which is what lets the suggest tool and pre-labeling offer it. Asking again
         *     re-asks and overwrites, so an endpoint that now serves a different model
         *     declares that on its next test.
         *
         *     **Only for an `http` connection.** A local one has no endpoint to ask: 409
         *     `INFERENCE_CONNECTION_NOT_TESTABLE`, the same answer `allowed_actions` gave.
         *     An endpoint that cannot be reached, does not answer in time, answers outside
         *     the contract, or declares a capability this build does not know is 502
         *     `INFERENCE_ENDPOINT_UNAVAILABLE`; the message names the endpoint and what
         *     happened, and nothing is recorded.
         *
         *     `200` with the connection rather than `202` with a job: one small request,
         *     answered while you wait.
         */
        post: operations["test_connection_endpoint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/inference/download-size": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Inference Download Size
         * @description How big fetching that model's weights would be, before anybody fetches them.
         *
         *     What the local-connection form shows beside its confirm control, so that
         *     "VisionSet downloads nothing on its own" is a decision somebody can actually
         *     make.
         *
         *     **This downloads nothing.** It reads the publishing hub's file listing, which
         *     is the one question answerable before the download it describes. The number
         *     covers every file in the revision, because that is what the download fetches.
         *
         *     Query parameters rather than a path, because a model id contains a slash
         *     (`facebook/sam2-hiera-base-plus`) and a segment that has to be escaped to be
         *     written is a URL people get wrong by hand.
         *
         *     **Not a connection route**, and it takes no connection id: the moment the
         *     number is needed is the moment before the connection exists. Asking about a
         *     connection that already exists is the same pair of values, asked the same way.
         *
         *     Refused with the install command when the local runtime is absent — the size
         *     is read with the same client that would do the fetching — and refused rather
         *     than guessed when the hub cannot size every file in the revision.
         */
        get: operations["inference_download_size"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/inference/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Providers
         * @description Every inference driver installed on this server, and what each offers.
         *
         *     `families` maps a model type — the `model_type` a checkpoint's own config
         *     declares — onto what a model of that type can be asked for. It is the same
         *     vocabulary `capabilities` uses on a connection, and it answers a different
         *     question: this says what *could* run here, that says what one configured
         *     connection's weights turned out to be.
         *
         *     `curated` is the checkpoints a driver offers by name, in the order it
         *     declared them, and each entry's `capability` is a member of that same
         *     vocabulary — the one its family resolves to, through the driver that
         *     declared both. Filter on it rather than switching on it: the vocabulary is
         *     open, so an entry may name an ability this client was never compiled
         *     against. Curation guides and never restricts: any model id remains typeable
         *     at any revision, and an empty list is an ordinary answer from a driver that
         *     runs whatever it is pointed at.
         *
         *     A curated entry carries **no size**. What a download costs is
         *     `GET /inference/download-size`, read live for the exact pair, because a
         *     number frozen into a catalog would be a second answer to a question already
         *     answered accurately.
         *
         *     Empty when nothing is installed, which is an answer rather than a failure.
         */
        get: operations["list_providers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/inference/suggest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Suggest Region
         * @description Propose a shape for the thing under those points.
         *
         *     The server side of the editor's suggest gesture. One asset, one prompt set,
         *     one answer — batch prediction is a separate path and is not this one.
         *
         *     **Nothing is written and nothing is remembered.** A suggestion is a proposal:
         *     accepting it is a later, ordinary annotation write carrying `provenance:
         *     model`, this response's `model_ref`, and its `confidence`. Discarding it
         *     costs a request that already finished. The only thing that outlives the call
         *     is a cached image embedding, which is an optimisation rather than a record —
         *     so the same points sent twice answer the same way, and a restart changes
         *     nothing but the latency of the first click.
         *
         *     **The first click on an asset is the slow one.** A segmenter reads the whole
         *     image once and then answers any number of clicks from that reading almost for
         *     free, which is what makes refining by adding points practical. Sending the
         *     accumulated points — rather than a diff — is what keeps this stateless.
         *
         *     **`allowed_geometries` is bounded by the caller's schema, and chosen within
         *     it.** The answer is produced in one of the kinds named or not at all: naming
         *     polygon gets the outline of the piece under the click, naming only box gets
         *     one box over every piece the mask kept, and naming neither gets no regions.
         *     Answering in a kind the schema would refuse would produce a suggestion that
         *     cannot be accepted, so every kind sent must be one the active class admits.
         *
         *     Which of them to send is the caller's decision, and it matters because **this
         *     route prefers the polygon whenever both are named**. A client whose user is
         *     holding a box tool over a class that also accepts polygons sends `["bbox"]`
         *     alone; sending both would answer past the tool they are holding, and nothing
         *     on their screen would have said so.
         *
         *     **`detail` is the one setting, and it does not reach the model.** It decides
         *     how much of an outline survives simplification. It is optional and defaults
         *     to `balanced`, which is what every suggestion used before there was a choice.
         *     Closing the small gaps in a mask and dropping its noise specks still happen,
         *     at fixed defaults nobody asks for.
         *
         *     **`parameters` says which settings apply here**, for the kind of shape this
         *     request will come back in. It is empty for a box class — `detail` changes an
         *     outline and a box has none — which is how a client is told to render no
         *     adjustments at all. It is present even when there is nothing to propose, so
         *     somebody who adjusted their way into an empty answer can adjust their way
         *     back out. A client renders what this names and works none of it out itself.
         *
         *     **`contour` on each region is the outline the shape was reduced from.** It is
         *     what lets a client re-run `detail` locally rather than asking again, and it
         *     is the *same* points this route reduced — simplification is not nested, so a
         *     client starting from anything else could not be held to the same answer. A
         *     box carries none, because there is nothing it was reduced from.
         *
         *     **Every point must be on the asset**, positive and negative alike — `x` in
         *     `[0, width]` and `y` in `[0, height]`, both ends included, in the asset's own
         *     pixel frame. One point off the picture refuses the whole request with 422
         *     `PROMPT_POINT_OUT_OF_BOUNDS` rather than being dropped, because a gesture
         *     with a point removed is a different gesture. Nothing is clamped: a
         *     coordinate outside the frame is not a place on the image, and answering
         *     about the nearest edge instead would return a mask, and a confidence, for a
         *     question nobody asked.
         *
         *     An empty `regions` is a successful answer with nothing to propose. These
         *     refusals are about the request, and the caller can act on each: an unknown
         *     project, asset or connection is 404 — `PROJECT_NOT_FOUND`, `ASSET_NOT_FOUND`
         *     or `INFERENCE_CONNECTION_NOT_FOUND`; a connection whose weights are not here
         *     yet is 409 `INFERENCE_CONNECTION_NOT_SET_UP` and names what to do; a
         *     connection whose model answers words rather than places is 422
         *     `UNSUPPORTED_PROMPT`, as is a prompt point off the asset; an `http`
         *     connection whose endpoint does not answer the contract is 502
         *     `INFERENCE_ENDPOINT_UNAVAILABLE`.
         *
         *     Three failures are about this installation rather than about the request,
         *     and answer 500 carrying the message that says which: a connection of a kind
         *     this build ships no adapter for is `INFERENCE_CONNECTION_NOT_RUNNABLE`, a
         *     machine without the optional local runtime is `LOCAL_INFERENCE_UNAVAILABLE`
         *     and carries the command that installs it, and a model that will not fit the
         *     device it was asked to run on is `INFERENCE_OUT_OF_MEMORY`. None of the
         *     three is worth resending unchanged: there is no state here to change, so the
         *     remedy is the one the message names — an install, a different device, a
         *     smaller model, or a build that ships the adapter.
         */
        post: operations["suggest_region"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
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
         *     An unknown job is 404 `JOB_NOT_FOUND`. The batch must be `in_annotation`, or
         *     this is 409 `BATCH_NOT_IN_ANNOTATION`, and the job itself must still be open:
         *     one that was completed is 409 `JOB_FINISHED`, and a completed job has no way
         *     back, so the remedy is a new job over those assets rather than a retry. An
         *     asset the job does not carry is 422 `ASSET_NOT_IN_JOB`.
         *
         *     An annotation the pinned version does not describe is 422
         *     `INVALID_ANNOTATION`, which is the general answer; the specific ones carry
         *     their own codes — `LABEL_CLASS_NOT_IN_SCHEMA`, `DISALLOWED_GEOMETRY`,
         *     `MISSING_REQUIRED_ATTRIBUTE` and their kin — so a client that wants to say
         *     what is wrong reads the code rather than the status.
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
         *     `ASSET_NOT_WRITABLE` here too, a batch that is not open for annotation is 409
         *     `BATCH_NOT_IN_ANNOTATION`, and a job that was completed is 409 `JOB_FINISHED`.
         *     An unknown job is 404 `JOB_NOT_FOUND`, and an id naming an annotation that
         *     sits outside this job is 422 `ASSET_NOT_IN_JOB`.
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
         *     An asset whose labeling is over is 409 `ASSET_NOT_WRITABLE`, as on the POST,
         *     and so are the two gates around it: a batch that is not open for annotation
         *     is 409 `BATCH_NOT_IN_ANNOTATION` and a job that was completed is 409
         *     `JOB_FINISHED`. An edit is a write, and every gate that stops a new label
         *     stops a replacement too.
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
         *     an error. Reading is not gated on job or batch state: a label outlives the
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
         *     kernel and a second spelling of it would drift: `unannotated` to `annotated`,
         *     `pre_labeled` or `skipped`; `pre_labeled` to `annotated`, `unannotated` or
         *     `skipped`; `annotated` to `review_pending` or back; `review_pending` to
         *     `accepted` or back to `annotated`; and `accepted` nowhere at all. Anything
         *     else is 409 `INVALID_TRANSITION`.
         *
         *     Setting the state an asset is already in is a no-op rather than a refusal —
         *     but the batch gate fires first, so writing into a closed batch is refused
         *     whether or not the value would have changed: 409 `BATCH_NOT_IN_ANNOTATION`.
         *
         *     409 `STALE_WRITE` is the other one, and it is not the same complaint: the
         *     move was legal from the state the caller read, and somebody else moved the
         *     asset in between. Re-read the progress and decide again — resending this
         *     request unchanged would land a decision made about a state nobody is in any
         *     more.
         *
         *     Labels move `unannotated`, `pre_labeled` and `annotated` on their own as
         *     annotations are written, edited or deleted. This route is for the decisions
         *     that are nobody's consequence: skipping, submitting for review, accepting.
         */
        put: operations["set_asset_progress"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}/assignee": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Assign Job
         * @description Name who is working this job, or clear it with `null`.
         *
         *     Informational only — a name, not an account. Legal in any job or batch
         *     state: naming who did a finished job is attribution, not a reopening.
         */
        put: operations["assign_job"];
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
         *     means the labeling has not happened, a `pre_labeled` one means a model's
         *     guess is still unjudged, and a `review_pending` one means the review has
         *     not; any of the three answers 409 `JOB_NOT_COMPLETE` and says how many are
         *     outstanding.
         *
         *     A job that is not `in_progress` is 409 `INVALID_TRANSITION`, and a batch that
         *     is not open for annotation is 409 `BATCH_NOT_IN_ANNOTATION`. Neither has a
         *     remedy on this route: `completed` is where the table ends, so settled work is
         *     corrected through a new batch rather than reopened.
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
         *     `BATCH_NOT_IN_ANNOTATION`. A job that is not `pending` has no such move to
         *     make and is 409 `INVALID_TRANSITION` — the table runs one way, so a job that
         *     is already in progress or finished never starts again.
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
         *     An unknown project is 404 `PROJECT_NOT_FOUND` and an unknown asset is 404
         *     `ASSET_NOT_FOUND`. An asset belonging to a different project answers the
         *     second of those rather than 403, like every cross-scope reference here.
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
         *     asset or the project, which is resolved first: 404 `PROJECT_NOT_FOUND` or 404
         *     `ASSET_NOT_FOUND`. A batch deleted between that read and its progress is 404
         *     `BATCH_NOT_FOUND`, and asking again answers without it.
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
         *     An unknown project or asset is 404 — `PROJECT_NOT_FOUND` and
         *     `ASSET_NOT_FOUND` — and those are the only two. 404 `WORKSPACE_CORRUPT` is
         *     not among the answers: a recorded hash with no blob behind it is a guarantee
         *     failing, and is 500.
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
         *     has reached it yet. A backfill fills what it can. The other two 404s are the
         *     ordinary ones, resolved before the cache is consulted: 404 `PROJECT_NOT_FOUND`
         *     and 404 `ASSET_NOT_FOUND`, which say the thing itself is not here rather than
         *     that its preview is missing.
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
         *     anybody re-cutting work by hand needs.
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
    "/projects/{project_id}/batches/pre-label": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Pre Label Project Batches
         * @description Ask a model to label every untouched asset across this project's open batches.
         *
         *     **One row per batch, and the batch stays the unit.** This launch fans out
         *     over the project's batches that are open for annotation — every one of
         *     them, or exactly the `batch_ids` named — and for each one queues the same
         *     `annotation.pre_label` job `POST /batches/{batch_id}/pre-label` queues, or
         *     joins the one already queued or running for that batch (`joined`). Each
         *     row is polled, cancelled and remembered per batch, exactly as a
         *     single-batch launch is: `GET /background-jobs/{id}` for progress counted
         *     in that batch's assets, `BatchOut.pre_label_run` afterwards. Nothing here
         *     reports one total across batches, because nothing here is one run.
         *
         *     **Refused whole, up front, and no refusal creates a row.** The connection
         *     is checked first, as the single-batch launch checks it: an unknown
         *     connection is 404 `INFERENCE_CONNECTION_NOT_FOUND`, one not set up yet is
         *     409 `INFERENCE_CONNECTION_NOT_SET_UP`, and a model that answers places
         *     rather than words is 422 `UNSUPPORTED_PROMPT`. Then the selection: an
         *     unknown project is 404 `PROJECT_NOT_FOUND`; a named batch outside this project is 404
         *     `BATCH_NOT_FOUND`; a named batch not `in_annotation`, a project with no
         *     open batch at all, or an empty `batch_ids`, is 409 `BATCH_NOT_IN_ANNOTATION`;
         *     any selected batch whose pinned schema has no class the model's shapes can
         *     be written as is 409 `SCHEMA_HAS_NO_DETECTABLE_CLASS`, and the message
         *     names the batch so the caller can leave it out by name and ask again. A
         *     partly launched project would leave rows the caller was never told about,
         *     which is why the whole request is refused instead.
         *
         *     What each run writes, passes over and counts is the single-batch launch's
         *     contract; read `POST /batches/{batch_id}/pre-label`.
         */
        post: operations["pre_label_project_batches"];
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
    "/projects/{project_id}/schema/blocking-assets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * List Blocking Assets
         * @description The frames behind `POST /preview`'s `blockers`, so a client can reach them.
         *
         *     `preview` answers *how many* annotations block this proposal and under which
         *     classes; this answers *which frames carry them*, from the same walk, so a
         *     count and a listing of one narrowing cannot disagree.
         *
         *     **The proposal is the whole class list, not a filter.** Which `(class, shape)`
         *     pairs are guarded is derived here from the diff, exactly as `preview` derives
         *     them — a client sending its own pairs could send a set the guard does not
         *     match, which is the disagreement this route exists to prevent.
         *
         *     Each item names the frame, how many of *its* annotations the change would
         *     orphan, which blocking classes they carry, and every batch holding it.
         *     `batch_ids` is a list because an asset put in a batch and later in a
         *     correction of it is in both. A frame blocking under two classes is one item,
         *     so `total` is not the sum of `preview`'s per-class `assets`.
         *
         *     `total` is every blocking frame, never the size of this page; an offset past
         *     the end is an empty list and a 200. An additive proposal blocks on nothing
         *     and answers an empty page.
         *
         *     **The order is insertion order** — the order the assets were first recorded,
         *     which nothing here re-sorts. It is stable across calls, which is what makes
         *     paging with `offset` safe; it is not the order any other asset listing
         *     publishes.
         *
         *     A POST for `preview`'s reason: a class list does not belong in a query
         *     string. It is still a read — nothing is written, nothing is locked — and
         *     `description` and `provenance` are accepted and ignored, so a client
         *     previews, lists and publishes the identical document.
         *
         *     An unknown project is 404 `PROJECT_NOT_FOUND`.
         */
        post: operations["list_blocking_assets"];
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
    "/projects/{project_id}/schema/drafts/{kind}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Schema Draft
         * @description The schema version this project is still writing, of that kind.
         *
         *     A project holds at most one draft per kind and they are shared: there are no
         *     per-user drafts, because the workspace has no users — a credential is not a
         *     person. `curated` is the one a schema editor writes; `annotation` is the one
         *     that accumulates while somebody is labeling and needs a class.
         *
         *     404 `SCHEMA_DRAFT_NOT_FOUND` means nobody has started one, which is the
         *     ordinary state of most projects. It is deliberately not the same refusal as
         *     an unknown project, which is 404 `PROJECT_NOT_FOUND`: the codes are what tell
         *     "there is nothing written yet" from "there is no such project".
         */
        get: operations["get_schema_draft"];
        /**
         * Save Schema Draft
         * @description Write the whole draft, creating it if there is none.
         *
         *     The body is the entire draft; there is no partial edit, for the reason there
         *     is none of a version. Classes here are **not** validated as a contract would
         *     be: a class with no name and no geometry is stored exactly as sent, which is
         *     what lets somebody put the work down mid-sentence.
         *
         *     `revision` is the revision this write was decided against, and omitting it
         *     asks to create. Either one refused answers 409 `STALE_WRITE`, which means
         *     somebody else wrote the draft first and this write was judged against an
         *     answer that had expired. Read it again and resubmit — nothing is merged, and
         *     nothing is overwritten.
         *
         *     The response carries the new `revision`, which is what the next write and the
         *     publish must name.
         */
        put: operations["save_schema_draft"];
        post?: never;
        /**
         * Discard Schema Draft
         * @description Throw the draft away.
         *
         *     Unconditional and revisionless, unlike every other write here: discarding is
         *     what somebody does having decided the work is not wanted, and making them
         *     read it first would be a round trip whose only purpose is to delete what it
         *     fetched. Discarding a draft that is not there is a 204 as well — the state
         *     afterwards is the state that was asked for.
         */
        delete: operations["discard_schema_draft"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/schema/drafts/{kind}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Publish Schema Draft
         * @description Turn the draft into the next schema version, and clear it.
         *
         *     The classes are the draft's, so nothing is sent here but the revision — which
         *     is what makes it impossible to publish something other than what the draft
         *     holds. The draft's note becomes the version's commit message and its kind
         *     becomes the version's `provenance`.
         *
         *     Every refusal `POST /versions` can give, this can give, for the same reasons
         *     and with the same overrides: 409 `DESTRUCTIVE_SCHEMA_CHANGE` until
         *     `allow_destructive=true`, and 409 `SCHEMA_CHANGE_WOULD_ORPHAN` with no
         *     override at all. One more is its own: 422 `INVALID_SCHEMA` when a class in
         *     the draft is not finished — a blank name, no geometry, a select with no
         *     options — naming it by position, `classes.3`. A draft is allowed to hold
         *     those; a version is not.
         *
         *     409 `STALE_WRITE` means the draft moved since `revision` was read, and no
         *     version was created. 409 `SCHEMA_VERSION_CONFLICT` means something else
         *     published while this call was deciding the next version number; that one is
         *     worth resending unchanged, since the retry re-reads the maximum.
         *
         *     The draft is gone afterwards even when nothing was written: publishing the
         *     contract already in force answers with the version already in force, and the
         *     draft that proposed it has nothing left to say.
         */
        post: operations["publish_schema_draft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/schema/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Preview Schema Change
         * @description Say what publishing these classes would do, without publishing anything.
         *
         *     Writes nothing, and answers both gates at once. `diff` is the classification
         *     `GET /compare` returns — whether this narrows the contract, and over which
         *     classes — so `diff.is_destructive` decides whether the publish needs
         *     `allow_destructive=true`.
         *
         *     **`is_refused` is the answer no flag changes.** True means annotations already
         *     exist under a class this proposal drops, so `POST /versions` answers 409
         *     `SCHEMA_CHANGE_WOULD_ORPHAN` however it is called, and `blockers` names each
         *     such class with how many annotations and how many assets carry it. That is the
         *     **same structure** the refusal itself puts in `detail`, so one renderer serves
         *     the warning and the refusal. Retrying with `allow_destructive=true` against a
         *     refused preview is the loop `code` exists to prevent.
         *
         *     A POST because the proposal is the whole class list and a class list does not
         *     belong in a query string. It is still a read: nothing is written, nothing is
         *     locked, and nothing is reserved. Somebody can label a class between this call
         *     and the publish, in which case the publish refuses and **that** refusal is the
         *     authoritative one — this removes the round trip that was doomed before it was
         *     sent, not the need to handle being refused.
         *
         *     The body is the same shape `POST /versions` takes, so a client previews and
         *     publishes the identical document. `description` and `provenance` are accepted
         *     and ignored: neither enters a diff, and requiring a client to strip them would
         *     make the two calls differ for no reason.
         */
        post: operations["preview_schema_change"];
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
         * @description Append the next version of the project's schema, and catch the open batches up.
         *
         *     The body is the whole proposed version; versions are never edited in place.
         *
         *     **A version that only widens the contract moves every open batch onto it**,
         *     in the same transaction, and `advanced_batches` names the ones that moved. A
         *     wider contract cannot invalidate a label already drawn, so nothing is at risk
         *     — which is exactly why a narrowing version moves nothing, `allow_destructive`
         *     or not. A batch is *open* if it is `approved` or `in_annotation`; a draft has
         *     no pin yet and takes the active version at approval, and a completed batch's
         *     pin is the record of what its work was judged against.
         *
         *     `advanced_batches` is empty when nothing followed, which is ordinary. A client
         *     that renders "published" without it cannot tell a version that moved two
         *     batches from one that moved none.
         *
         *     **Sending the classes that are already in force writes nothing.** The answer
         *     is the version that was already active, and it is not an error: the version
         *     a client holds afterwards is the one in force either way, which is the only
         *     thing it asked for. Identical means the classes match exactly — names,
         *     geometries, colours, attributes and order — so a colour change is a change
         *     and does publish a version.
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
         *
         *     The third 409 is the one that *is* worth an immediate retry: two writers
         *     racing for the same next version number is `SCHEMA_VERSION_CONFLICT`, and
         *     resending the identical request re-reads the maximum and lands on the one
         *     after it. No flag is involved, and none is needed.
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
         *     `name` exists because the staged path's basename is a digest; a blank one is
         *     422 `INVALID_NAME`, refused by the kernel's own `InvalidName` — the domain
         *     already refuses with a mapped error, so no wire validator restates it.
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
         *     whose bytes will not decode, is 422 here rather than a run that fails later:
         *     422 `UNSUPPORTED_MEDIA` for a kind of file this cannot cut, and 422
         *     `CORRUPT_MEDIA` for one that is the right kind and will not decode. The
         *     message says what was wrong with the file and never where it was put.
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
         *     all-train would be indistinguishable from a real recipe that said so. An
         *     unknown release is the other 404, `RELEASE_NOT_FOUND` — the code is what
         *     tells "there is no such release" from "that release divides into one fold".
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
         *     identical call plus `allow_lossy=true`. An unknown release is 404
         *     `RELEASE_NOT_FOUND`. None of the three creates a job, so a caller holding a
         *     job id holds one that will run.
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
         *     409 `BATCH_NOT_EDITABLE` — and an unknown one is 404 `BATCH_NOT_FOUND`. Both
         *     are answered here, before the job row is written, as is 404
         *     `SOURCE_NOT_FOUND` for the source this run would read. `batch_name` names a new batch instead;
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
         * ActivityEntryOut
         * @description One thing that happened, derived from a timestamp that already existed.
         */
        ActivityEntryOut: {
            /** Count */
            count: number | null;
            kind: components["schemas"]["ActivityKind"];
            /** Label */
            label: string | null;
            /**
             * Occurred At
             * Format: date-time
             */
            occurred_at: string;
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
            /** Project Name */
            project_name: string;
            /**
             * Subject Id
             * Format: uuid
             */
            subject_id: string;
        };
        /**
         * ActivityKind
         * @description What sort of thing a row of the activity feed is.
         *
         *     Four kinds, and two of them are approximations the interface must not
         *     overstate. See :class:`ActivityEntry` for which and why.
         * @enum {string}
         */
        ActivityKind: "release_published" | "batch_promoted" | "ingest" | "schema_version";
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
         * AppliedParameters
         * @description The parameter values this answer was actually produced with.
         */
        AppliedParameters: {
            detail: components["schemas"]["Detail"];
        };
        /**
         * AssetAction
         * @description What can be asked of one asset inside a batch.
         *
         *     ``ANNOTATE`` is the odd one and the important one: it is not a progress move
         *     but the right to write labels at all, which is ``WRITABLE_PROGRESS`` and the
         *     batch gate together. The other six each name one edge of
         *     ``ASSET_PROGRESS_TRANSITIONS`` — see :data:`ASSET_MOVES`.
         * @enum {string}
         */
        AssetAction: "annotate" | "skip" | "restore" | "confirm" | "submit_for_review" | "accept" | "return_to_annotator" | (string & {});
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
        AssetProgress: "unannotated" | "pre_labeled" | "annotated" | "skipped" | "review_pending" | "accepted";
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
         * AssetSort
         * @description How a batch's asset listing is ordered.
         * @enum {string}
         */
        AssetSort: "membership" | "confidence";
        /**
         * AttentionItemOut
         * @description One thing in the workspace that is waiting on somebody.
         */
        AttentionItemOut: {
            /** Count */
            count: number | null;
            /** Detail */
            detail: string | null;
            kind: components["schemas"]["AttentionKind"];
            /** Label */
            label: string;
            /** Processed */
            processed: number | null;
            /** Project Id */
            project_id: string | null;
            /** Project Name */
            project_name: string | null;
            /**
             * Subject Id
             * Format: uuid
             */
            subject_id: string;
            /** Total */
            total: number | null;
        };
        /**
         * AttentionKind
         * @description What sort of thing a row of the attention list is.
         *
         *     A ``StrEnum`` rather than a plain ``str`` on the ``SourceKind`` test: no
         *     writer outside this build produces one, the value decides how a row renders,
         *     and the set grows deliberately. Contrast ``DatasetChange.operation``, which
         *     is a plain ``str`` precisely because a log outlives the build that wrote it.
         * @enum {string}
         */
        AttentionKind: "review_pending" | "pre_labeled" | "job_failed" | "job_running";
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
            /** Error Code */
            error_code: string | null;
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
        BatchAction: "approve" | "start" | "complete" | "repin" | "promote" | "create_correction" | "pre_label" | "edit_membership" | "delete" | (string & {});
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
         *
         *     `annotation_count` is every label on this asset. `min_confidence` is the lowest
         *     confidence among the labels a model wrote, or `null` when none carries one; the
         *     scale is the one the model that wrote them scores on — a text-prompt detector's
         *     prompt affinity, a point-prompt segmenter's mask quality.
         */
        BatchAssetOut: {
            /** Allowed Actions */
            allowed_actions: components["schemas"]["AssetAction"][];
            /** Annotation Count */
            annotation_count: number;
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
            /** Min Confidence */
            min_confidence: number | null;
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
            pre_label_run: components["schemas"]["PreLabelRunOut"] | null;
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
        /**
         * BboxGeometry
         * @description An axis-aligned rectangle: top-left corner plus size.
         *
         *     ``width`` and ``height`` must be strictly positive — a zero-area box is as
         *     meaningless as a negative one, so neither is accepted. A box may extend
         *     beyond an asset's frame, but cannot be wholly disjoint when that asset
         *     records its dimensions.
         */
        BboxGeometry: {
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
        /**
         * BlockingAssetOut
         * @description One frame standing in the way of a narrowing, and where to reach it.
         */
        BlockingAssetOut: {
            /** Annotations */
            annotations: number;
            asset: components["schemas"]["AssetOut"];
            /** Batch Ids */
            batch_ids: string[];
            /** Label Classes */
            label_classes: string[];
        };
        /**
         * BlockingAssetPage
         * @description A page of the frames blocking a narrowing.
         */
        BlockingAssetPage: {
            /** Items */
            items: components["schemas"]["BlockingAssetOut"][];
            /** Total */
            total: number;
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
         * ClassificationGeometry
         * @description A whole-asset tag: the annotation carries a class but no coordinates.
         *
         *     It exists as a variant rather than as ``geometry: None`` so that every
         *     annotation has a geometry with a discriminator, and so the union stays the
         *     single place that answers "what shape is this label?".
         */
        ClassificationGeometry: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "classification_tag";
        };
        /**
         * ConnectionAction
         * @description What can be asked of an inference connection. Order is display order.
         * @enum {string}
         */
        ConnectionAction: "download_weights" | "check_integrity" | "test_endpoint" | "update" | "delete" | (string & {});
        /**
         * ConnectionCreate
         * @description What a caller supplies to configure a connection.
         *
         *     ``setup_state`` is absent on purpose: it is derived from the kind by the
         *     service, because it says what the kind still needs rather than what the
         *     caller wants. Accepting it would let a client declare weights present that
         *     were never fetched, so supplying it is refused along with any other field
         *     this shape does not declare.
         */
        ConnectionCreate: {
            connection_type: components["schemas"]["ConnectionType"];
            /** Credential Env */
            credential_env?: string | null;
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
            precision?: components["schemas"]["Precision"] | null;
            /** Provider Id */
            provider_id?: string | null;
        };
        /**
         * ConnectionOut
         * @description One configured place a model can be asked to predict.
         */
        ConnectionOut: {
            /** Allowed Actions */
            allowed_actions: components["schemas"]["ConnectionAction"][];
            /** Capabilities */
            capabilities: components["schemas"]["ModelCapability"][];
            connection_type: components["schemas"]["ConnectionType"];
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Credential Env */
            credential_env: string | null;
            /** Device */
            device: string | null;
            download: components["schemas"]["WeightDownloadOut"] | null;
            /** Endpoint Url */
            endpoint_url: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            integrity_check: components["schemas"]["IntegrityCheckOut"] | null;
            /** Model Id */
            model_id: string;
            /** Model Revision */
            model_revision: string;
            /** Name */
            name: string;
            precision: components["schemas"]["Precision"] | null;
            /** Provider Id */
            provider_id: string | null;
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
         *     a successful weight download clears, as its **last** step: a run that fails
         *     partway leaves the row exactly where it was, so there is no third state
         *     meaning "half fetched" and no window in which a caller could read one.
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
         *     clearing one would produce a row the domain refuses anyway. The one
         *     exception is ``credential_env``, the one optional parameter a person removes
         *     as readily as sets: the empty string clears it.
         */
        ConnectionUpdate: {
            /** Credential Env */
            credential_env?: string | null;
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
            precision?: components["schemas"]["Precision"] | null;
            /** Provider Id */
            provider_id?: string | null;
        };
        /**
         * CuratedModelOut
         * @description A checkpoint a driver offers by name, and what it can be asked for.
         */
        CuratedModelOut: {
            /** Access Note */
            access_note: string | null;
            /** Access Url */
            access_url: string | null;
            /** Capability */
            capability: string;
            /** Family */
            family: string;
            /** Hint */
            hint: string;
            /** Model Id */
            model_id: string;
            /** Model Revision */
            model_revision: string;
            /** Provider Id */
            provider_id: string;
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
         * Detail
         * @description How much of an outline survives simplification. Order is display order.
         * @enum {string}
         */
        Detail: "coarse" | "balanced" | "fine";
        /**
         * DownloadSizeOut
         * @description What fetching a model's weights would cost, before anybody fetches them.
         *
         *     Answered from the publishing hub's file listing, so asking costs a metadata
         *     request and never a download. The pair is echoed back for ``SuggestionOut``'s
         *     reason: a form that had to remember which model it asked about would be
         *     keeping a second copy of something the response can simply state.
         */
        DownloadSizeOut: {
            /** File Count */
            file_count: number;
            /** Model Id */
            model_id: string;
            /** Model Revision */
            model_revision: string;
            /** Total Bytes */
            total_bytes: number;
        };
        /**
         * DraftAttributeBody
         * @description One attribute of a class somebody is still writing.
         *
         *     Every field is optional, including `kind`, and no rule spanning two of them
         *     is checked. A draft is not a contract: an attribute that has been named but
         *     not yet typed is an ordinary moment in building one, and refusing to store it
         *     would lose exactly the work a draft exists to keep. Every rule
         *     `AttributeBody` states is checked when the draft is published.
         */
        DraftAttributeBody: {
            /** Default */
            default?: boolean | number | string | null;
            /** Kind */
            kind?: ("string" | "number" | "boolean" | "select") | null;
            /**
             * Name
             * @default
             */
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
         * DraftLabelClassBody
         * @description One class being written: a name that may be blank, shapes that may be none.
         *
         *     `geometries` has no minimum here and does on `LabelClassBody`, which is the
         *     difference between the two types. Publishing the draft applies the minimum.
         */
        DraftLabelClassBody: {
            /**
             * Attributes
             * @default []
             */
            attributes: components["schemas"]["DraftAttributeBody"][];
            /** Color */
            color?: string | null;
            /**
             * Geometries
             * @default []
             */
            geometries: components["schemas"]["GeometryType"][];
            /**
             * Name
             * @default
             */
            name: string;
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
         * HomeOut
         * @description Everything the workspace's front page asks for, in one answer.
         */
        HomeOut: {
            /** Activity */
            activity: components["schemas"]["ActivityEntryOut"][];
            /** Attention */
            attention: components["schemas"]["AttentionItemOut"][];
            /** Projects */
            projects: components["schemas"]["ProjectSummaryOut"][];
            resume: components["schemas"]["ResumeTargetOut"] | null;
            totals: components["schemas"]["WorkspaceTotalsOut"];
        };
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
         * @description What became of one item the run could not simply read, split by remedy.
         *
         *     An enum rather than a plain ``str``, on exactly ``SourceKind``'s terms: the
         *     set is closed, no writer outside this build produces a value, and the kernel
         *     branches on it. What makes it worth a type at all is that a report has to be
         *     **grouped**, not read — ``CorruptMedia``'s docstring is explicit that a
         *     report unable to separate the kinds would bury real data loss under ordinary
         *     operator noise, and a reason sentence cannot be grouped on.
         *
         *     ``PARTIAL`` is the third member and the only one that is not a total loss.
         *     It exists because the two below cannot say the thing an operator most needs
         *     to hear about a damaged clip: *some of it is in your batch*. Filing a
         *     truncated video as ``CORRUPT`` is true of the file and misleading about the
         *     run, which had just created assets from it.
         * @enum {string}
         */
        IngestFailureKind: "unsupported" | "corrupt" | "partial";
        /**
         * IngestFailureOut
         * @description What became of one item the run could not simply read.
         */
        IngestFailureOut: {
            /** Frames Expected Estimate */
            frames_expected_estimate: number | null;
            /** Frames Produced */
            frames_produced: number | null;
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
         * IntegrityCheckOut
         * @description A connection's snapshot re-read: which job, how far, and how it ended.
         *
         *     `WeightDownloadOut`'s sibling over the same files, and present on the same
         *     terms: whenever a check has ever been asked for on this connection, describing
         *     the most recent one. It is how a client shows a run it did not itself start —
         *     a reload, a second tab, another machine, or `visionset inference
         *     check-integrity` in a terminal — rather than a job id somebody happened to
         *     keep.
         *
         *     Polling it never affects the run. The job is dispatched to a worker process
         *     the server owns; no client disconnect cancels or pauses it.
         *
         *     **Files, where a download counts bytes.** A check owns its loop and knows how
         *     many files the revision names before it opens the first one, so it reports
         *     what it actually counts. Neither borrows the other's name.
         *
         *     **The verdict is not here.** A pass leaves `setup_state` at `ready`; a failure
         *     has already purged the damaged files and stood the connection down by the time
         *     `state` says `failed`. So what a reader acts on is the connection's own state
         *     and the actions it now declares, and what this adds is the sentence saying
         *     why.
         */
        IntegrityCheckOut: {
            /** Error */
            error: string | null;
            /** Error Code */
            error_code: string | null;
            /** Files Read */
            files_read: number;
            /** Files Total */
            files_total: number | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            state: components["schemas"]["BackgroundJobState"];
        };
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
        JobAction: "start" | "complete" | (string & {});
        /**
         * JobAssign
         * @description The name to record for this job, or null to clear it.
         */
        JobAssign: {
            /** Assignee */
            assignee: string | null;
        };
        /**
         * JobOut
         * @description One annotator's unit of work over a segment of a batch.
         */
        JobOut: {
            /** Allowed Actions */
            allowed_actions: components["schemas"]["JobAction"][];
            /** Asset Count */
            asset_count: number;
            /** Assignee */
            assignee: string | null;
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
         * @description One labelable class, and the geometries an annotation of it may carry.
         */
        LabelClassBody: {
            /**
             * Attributes
             * @default []
             */
            attributes: components["schemas"]["AttributeBody"][];
            /** Color */
            color?: string | null;
            /** Geometries */
            geometries: components["schemas"]["GeometryType"][];
            /** Name */
            name: string;
        };
        /**
         * ModelCapability
         * @description What a connection's model can be asked for: the kind of prompt it takes.
         * @enum {string}
         */
        ModelCapability: "point_suggest" | "text_detect" | (string & {});
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
         * PolygonGeometry
         * @description A closed polygon, as at least three ``(x, y)`` vertices.
         *
         *     The closing edge is implicit: the last point joins the first, and repeating
         *     the first point at the end is NOT expected. Self-intersection is not
         *     validated — M1 accepts any ring of three or more points, and rejecting
         *     degenerate shapes is left to a later milestone.
         */
        PolygonGeometry: {
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
         * PolylineGeometry
         * @description An open path, as at least two ``(x, y)`` vertices in order.
         *
         *     The contrast with :class:`PolygonGeometry` is the whole definition: a polygon
         *     is a *ring* whose closing edge is implicit, and a polyline is a *path* whose
         *     ends stay apart. Nothing joins the last point to the first, and a caller that
         *     repeats the first point at the end has drawn a closed path — which is a legal
         *     polyline, and not the same value as the polygon with those vertices.
         *
         *     **The order of the points is the geometry**, not an incidental detail of how
         *     they were collected. A lane runs from one end to the other, and reversing the
         *     list is a different annotation of the same pixels. There is nothing to
         *     validate in that — an ordered sequence is ordered — which is worth saying
         *     because the ordering rule a lane *format* wants is a different rule: TuSimple
         *     requires points sorted by ascending Y, and :mod:`visionset.formats.lanes`
         *     enforces that at the boundary where it applies. Putting it here would make one
         *     format's invariant a condition of storing a lane at all, and would refuse
         *     every horizontal path in a domain that has no idea what a road is.
         *
         *     Degeneracy is refused in exactly one case, the analogue of the zero-area box
         *     :class:`BboxGeometry` already declines: a path whose points are all the same
         *     point has no length and describes nothing. Consecutive duplicates within a
         *     longer path are left alone — they arrive from real digitizers and from honest
         *     resampling, and they cost a renderer nothing — and self-intersection is not
         *     validated here for the same reason it is not validated for a polygon.
         */
        PolylineGeometry: {
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
         * PreLabelExclusionOut
         * @description A class in a batch's pinned schema that a pre-labeling run will not ask for.
         *
         *     Both reasons are properties of the class as the schema declares it read
         *     against the model's `produces`, so the remedy is a schema edit or a
         *     different model: give the class one of the shapes the model answers in, or
         *     drop the `required` flag from the attribute a prediction cannot supply.
         *
         *     `reasons` can carry both at once, and every reason that holds is listed —
         *     a class told only that it admits no shape the model produces, then given
         *     one, would otherwise stay silently absent from the next run's prompt.
         */
        PreLabelExclusionOut: {
            /** Name */
            name: string;
            /** Reasons */
            reasons: components["schemas"]["PreLabelExclusionReason"][];
        };
        /**
         * PreLabelExclusionReason
         * @description Why a schema's class is not among the words a run asks for.
         *
         *     Open because it travels as a list a client renders member by member rather
         *     than switches on: a release that finds a third way a class cannot hold a
         *     detection must not cost an older client the whole plan, and the class it
         *     names is visibly left out whether or not that client can word the reason.
         * @enum {string}
         */
        PreLabelExclusionReason: "no_producible_geometry" | "required_attribute" | (string & {});
        /**
         * PreLabelPlanOut
         * @description The words a run would ask a model for over this batch, and the shapes it would write.
         *
         *     A run's prompt is the batch's pinned schema, narrowed to the classes the
         *     model's declared shapes can be written as. That narrowing is invisible in
         *     the run's result — a schema whose `vehicle` class requires a `color`
         *     attribute yields no vehicles and no explanation — so it is published here,
         *     before a run starts, with the left-out classes named beside the asked-for
         *     ones.
         *
         *     Every class the pinned schema declares appears in exactly one of the two
         *     lists, both in the schema's own declaration order. A batch whose schema has
         *     no askable class at all is refused rather than answered with an empty
         *     `asked_classes`: pre-labeling it is impossible, not merely unproductive.
         */
        PreLabelPlanOut: {
            /** Asked Classes */
            asked_classes: string[];
            /** Excluded Classes */
            excluded_classes: components["schemas"]["PreLabelExclusionOut"][];
            /** Produces */
            produces: components["schemas"]["GeometryType"][];
            /** Schema Version */
            schema_version: number;
        };
        /**
         * PreLabelRequest
         * @description Which model should pre-label this batch, how sure it has to be, and whether it
         *     may replace its own earlier labels.
         */
        PreLabelRequest: {
            /**
             * Connection Id
             * Format: uuid
             */
            connection_id: string;
            /**
             * Minimum Confidence
             * @default 0.35
             */
            minimum_confidence: number;
            /**
             * Replace Model Labels
             * @default false
             */
            replace_model_labels: boolean;
        };
        /**
         * PreLabelRunOut
         * @description A batch's most recent pre-labeling run: which job, how far, and what it found.
         *
         *     Present whenever pre-labeling has ever been asked for on this batch, and
         *     describing the most recent run — including one this session did not launch.
         *     A dialog reopened after a reload, in a second tab, or after a run started
         *     from the terminal reads the same state from here rather than from a job id
         *     a component happened to keep.
         *
         *     **Assets, where a download counts bytes and a check counts files.** The
         *     handler owns a loop over the batch's untouched assets and knows the whole
         *     set before the first forward pass, so both its progress and its total are
         *     counted in the unit its own work is over.
         *
         *     **The outcome, once the job has one.** `stopped_early`, `assets_labeled`,
         *     `regions_discarded`, `regions_out_of_bounds` and `annotations_replaced` are
         *     the handler's own account of what a settled run did.
         *     They are `null` while the job is still `queued` or `running`, and `null`
         *     where it ended `failed` before producing one — but a `cancelled` run still
         *     carries them: stopping partway is a coherent outcome for a handler whose
         *     contract is to write only where nothing has been written.
         */
        PreLabelRunOut: {
            /** Annotations Replaced */
            annotations_replaced: number | null;
            /** Assets Labeled */
            assets_labeled: number | null;
            /** Assets Processed */
            assets_processed: number;
            /** Assets Total */
            assets_total: number | null;
            /** Error */
            error: string | null;
            /** Error Code */
            error_code: string | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /** Regions Discarded */
            regions_discarded: number | null;
            /** Regions Out Of Bounds */
            regions_out_of_bounds: number | null;
            state: components["schemas"]["BackgroundJobState"];
            /** Stopped Early */
            stopped_early: boolean | null;
        };
        /**
         * Precision
         * @description The numeric precision a local connection asks its weights to be loaded in.
         *
         *     A closed vocabulary rather than the free text this field started as, on
         *     ``ConnectionType``'s test: the set is small, the kernel is what decides
         *     whether a member is usable on a given device, and it grows only by a
         *     deliberate kernel change — bf16 arriving later is exactly that change.
         *
         *     Free text here was not neutrality but a gap. ``fp32x`` was accepted and then
         *     ignored; so was ``fp16`` beside ``cpu``, which the adapters silently drop
         *     (see :func:`precisions_for`). A field whose wrong values are absorbed rather
         *     than refused is a field that cannot tell somebody they are configuring a run
         *     that will not happen.
         * @enum {string}
         */
        Precision: "fp16" | "fp32";
        /**
         * ProgressCounts
         * @description How many assets sit in each annotation state.
         */
        ProgressCounts: {
            /** Accepted */
            accepted: number;
            /** Annotated */
            annotated: number;
            /** Pre Labeled */
            pre_labeled: number;
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
         *
         *     `thumbnail_asset_id` names the image that stands for the project in a
         *     listing — the first asset of its earliest batch that has one — and
         *     `thumbnail_hash` is that asset's cached preview. Both are null for a
         *     project with no images; the id set with a null hash means the asset has no
         *     cached preview, so there is nothing to fetch.
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
            /** Thumbnail Asset Id */
            thumbnail_asset_id: string | null;
            /** Thumbnail Hash */
            thumbnail_hash: string | null;
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
         * ProjectPreLabelItemOut
         * @description One batch's row in a project-wide launch.
         */
        ProjectPreLabelItemOut: {
            /**
             * Batch Id
             * Format: uuid
             */
            batch_id: string;
            /** Batch Name */
            batch_name: string;
            job: components["schemas"]["BackgroundJobOut"];
            /** Joined */
            joined: boolean;
        };
        /**
         * ProjectPreLabelOut
         * @description Every batch the launch fanned out over, one row each, in selection order.
         */
        ProjectPreLabelOut: {
            /** Items */
            items: components["schemas"]["ProjectPreLabelItemOut"][];
            /** Total */
            total: number;
        };
        /**
         * ProjectPreLabelRequest
         * @description Which model should pre-label this project's open batches, and which batches.
         *
         *     `batch_ids` absent means every batch of the project that is open for
         *     annotation; present means exactly those — a batch outside the project is
         *     404, one not open is 409, an empty list names nothing and is 409 too, and
         *     the request is refused whole, never partly launched.
         */
        ProjectPreLabelRequest: {
            /** Batch Ids */
            batch_ids?: string[] | null;
            /**
             * Connection Id
             * Format: uuid
             */
            connection_id: string;
            /**
             * Minimum Confidence
             * @default 0.35
             */
            minimum_confidence: number;
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
         * ProjectSummaryOut
         * @description One project, as a shortcut rather than as the project list.
         */
        ProjectSummaryOut: {
            /** Annotated Fraction */
            annotated_fraction: number;
            /** Asset Count */
            asset_count: number;
            /** Name */
            name: string;
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
        };
        /**
         * ProviderOut
         * @description An installed inference driver: what it serves, and what it offers by name.
         */
        ProviderOut: {
            /** Curated */
            curated: components["schemas"]["CuratedModelOut"][];
            /** Families */
            families: {
                [key: string]: string;
            };
            /** Provider Id */
            provider_id: string;
        };
        /**
         * ProviderPage
         * @description A page of installed inference drivers.
         */
        ProviderPage: {
            /** Items */
            items: components["schemas"]["ProviderOut"][];
            /** Total */
            total: number;
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
         * ResumeKind
         * @description What an open batch is being offered for, and so what `next_asset_id` is.
         *
         *     `annotate` - a frame nobody has judged, whether nobody has labeled it or
         *     only a model has, which is that frame. `review` - every frame is judged
         *     and some await a reviewer, which is the first of those. `open` - neither,
         *     and `next_asset_id` is null.
         * @enum {string}
         */
        ResumeKind: "annotate" | "review" | "open";
        /**
         * ResumeTargetOut
         * @description The batch to carry on with, what for, and where inside it to land.
         *
         *     `thumbnail_asset_id` names the frame that stands for the batch on the card
         *     and `thumbnail_hash` is that asset's cached preview. Both are null for a
         *     batch with no assets; the id set with a null hash means the asset has no
         *     cached preview, so there is nothing to fetch.
         */
        ResumeTargetOut: {
            /** Annotated */
            annotated: number;
            /**
             * Batch Id
             * Format: uuid
             */
            batch_id: string;
            /** Batch Name */
            batch_name: string;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            kind: components["schemas"]["ResumeKind"];
            /** Next Asset Id */
            next_asset_id: string | null;
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
            /** Project Name */
            project_name: string;
            /** Review Pending */
            review_pending: number;
            /** Thumbnail Asset Id */
            thumbnail_asset_id: string | null;
            /** Thumbnail Hash */
            thumbnail_hash: string | null;
            /** Total */
            total: number;
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
         * SchemaChangePreviewOut
         * @description What publishing a proposed version would do, and what would stop it.
         */
        SchemaChangePreviewOut: {
            /** Blockers */
            blockers: components["schemas"]["ClassCountOut"][];
            diff: components["schemas"]["SchemaDiffOut"];
            /** Is Refused */
            is_refused: boolean;
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
         * SchemaDraftBody
         * @description The whole draft. There is no partial edit of one, as there is none of a version.
         *
         *     `revision` is the revision this write was decided against. Omit it to
         *     *create*: a client that has not read the draft has not seen what it would
         *     overwrite, so creating is the only thing it may ask for. Sending a revision
         *     that is no longer stored answers 409 `STALE_WRITE`, and the remedy is to read
         *     the draft again and resubmit.
         */
        SchemaDraftBody: {
            /** Based On */
            based_on?: number | null;
            /**
             * Classes
             * @default []
             */
            classes: components["schemas"]["DraftLabelClassBody"][];
            /**
             * Note
             * @default
             */
            note: string;
            /** Revision */
            revision?: number | null;
        };
        /**
         * SchemaDraftOut
         * @description A schema version somebody is still writing.
         *
         *     One per project per `kind`, shared by everybody with access to the workspace —
         *     there are no per-user drafts, because there are no users. `based_on` is the
         *     version it was seeded from, so a draft whose `based_on` is behind the active
         *     version was written against a contract that has since moved.
         *
         *     `revision` is what a write or a publish must name to be accepted.
         */
        SchemaDraftOut: {
            /** Based On */
            based_on: number | null;
            /** Classes */
            classes: components["schemas"]["DraftLabelClassBody"][];
            kind: components["schemas"]["SchemaProvenance"];
            /** Note */
            note: string;
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
            /** Revision */
            revision: number;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /**
         * SchemaDraftPublish
         * @description Which revision of the draft to publish.
         */
        SchemaDraftPublish: {
            /** Revision */
            revision: number;
        };
        /**
         * SchemaProvenance
         * @description Which kind of work a schema version came from.
         *
         *     `curated` is a version authored deliberately — somebody sat down and decided
         *     what the project labels. `annotation` is one that fell out of adding a class
         *     part-way through labeling an asset. It gates nothing and is part of no
         *     contract comparison; a version history uses it to tell the milestones apart
         *     from the incidental runs between them.
         *
         *     The same two words also say which kind of work a *draft* belongs to, and a
         *     draft publishes under its own kind — so a project holds at most one draft of
         *     each, and the two never publish each other's classes.
         * @enum {string}
         */
        SchemaProvenance: "curated" | "annotation";
        /**
         * SchemaPublicationOut
         * @description A published version, and the open batches that moved onto it.
         */
        SchemaPublicationOut: {
            /**
             * Advanced Batches
             * @default []
             */
            advanced_batches: string[];
            published: components["schemas"]["SchemaVersionOut"];
        };
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
         * SuggestParameter
         * @description A setting that shapes a suggestion. Order is display order.
         * @enum {string}
         */
        SuggestParameter: "detail" | (string & {});
        /**
         * SuggestPoint
         * @description One click, in the asset's own pixel coordinates.
         *
         *     An object rather than a two-element array because a JSON ``[x, y]`` is a
         *     shape a generated client types as ``number[]`` and a reader has to guess the
         *     order of. The domain's own tuples are fine — Python has positional meaning —
         *     but the wire is read by people.
         *
         *     Must be on the asset: `x` in `[0, width]` and `y` in `[0, height]`, both
         *     ends included. The bounds cannot be stated as field constraints, because
         *     they belong to the asset the request names rather than to the point, so a
         *     coordinate off the picture is refused by the route with
         *     `PROMPT_POINT_OUT_OF_BOUNDS` rather than by this schema.
         */
        SuggestPoint: {
            /** X */
            x: number;
            /** Y */
            y: number;
        };
        /**
         * SuggestRequest
         * @description Where somebody clicked, on what, through which connection.
         *
         *     Everything travels in the body rather than in the path: the call names an
         *     asset *and* a connection, and neither owns the other. Putting one in the path
         *     would make it look like the parent of the request, which is how a URL is
         *     read.
         */
        SuggestRequest: {
            /** Allowed Geometries */
            allowed_geometries: components["schemas"]["GeometryType"][];
            /**
             * Asset Id
             * Format: uuid
             */
            asset_id: string;
            /**
             * Connection Id
             * Format: uuid
             */
            connection_id: string;
            /** @default balanced */
            detail: components["schemas"]["Detail"];
            /** Negative */
            negative?: components["schemas"]["SuggestPoint"][];
            /** Positive */
            positive: components["schemas"]["SuggestPoint"][];
            /**
             * Project Id
             * Format: uuid
             */
            project_id: string;
        };
        /**
         * SuggestedRegion
         * @description One proposed shape, and the contour it was reduced from.
         */
        SuggestedRegion: {
            /** Contour */
            contour: [
                number,
                number
            ][];
            /** Geometry */
            geometry: components["schemas"]["BboxGeometry"] | components["schemas"]["PolygonGeometry"] | components["schemas"]["PolylineGeometry"] | components["schemas"]["ClassificationGeometry"];
        };
        /**
         * SuggestionOut
         * @description What the model proposes, or an honest nothing.
         *
         *     `regions` is empty when there is no suggestion, and that is an ordinary
         *     answer rather than an error: a click can land on sky, the model can be less
         *     sure than the caller asked for, the shape found can be one this class cannot
         *     hold, and the detail as set can leave nothing. A 404 or a 409 for any of
         *     those would be telling the caller they did something wrong when they did not.
         *
         *     `model_ref` is echoed on every answer, including the empty one, because it
         *     is what an accepted suggestion has to carry into its annotation — and a
         *     caller that had to remember which connection it asked would be keeping a
         *     second copy of something the response can simply state. `confidence` is the
         *     same: one number for the answer, because the model scored one mask and the
         *     pieces cut out of it are that same claim seen in parts.
         *
         *     `parameters` names which settings have any effect on the kind of shape this
         *     request will come back in, so a client renders exactly those and works none
         *     of it out for itself. It is empty for a box class, which is how a client is
         *     told to render no adjustments at all. It is present on an empty answer too,
         *     which is what lets somebody who adjusted their way into nothing adjust their
         *     way back out.
         */
        SuggestionOut: {
            applied: components["schemas"]["AppliedParameters"];
            /** Confidence */
            confidence: number;
            /** Model Ref */
            model_ref: string;
            /** Parameters */
            parameters: components["schemas"]["SuggestParameter"][];
            /** Regions */
            regions: components["schemas"]["SuggestedRegion"][];
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
        /**
         * WeightDownloadOut
         * @description A connection's weight transfer: which job, how far it has got, how it ended.
         *
         *     Present whenever a download has ever been asked for on this connection, and
         *     describing the most recent one. It is how a client shows a transfer it did not
         *     itself start: a download outlives the request that launched it and the page
         *     that asked, so a reload, a second tab or another machine all read the same
         *     progress from here rather than from a job id somebody happened to keep.
         *
         *     Polling this — through the connection or through
         *     `GET /background-jobs/{job_id}` — never affects the run. The job is dispatched
         *     to a worker process the server owns; no client disconnect cancels or pauses
         *     it, and closing the browser during a download is not a way to stop one.
         *
         *     **It is not a setup state.** `setup_state` says whether the weights are
         *     *here*; this says whether something is currently fetching them. The two are
         *     separate on purpose: a connection is `ready` only once a snapshot is complete,
         *     so there is no moment at which one is half set up.
         */
        WeightDownloadOut: {
            /** Bytes Done */
            bytes_done: number;
            /** Bytes Total */
            bytes_total: number | null;
            /** Error */
            error: string | null;
            /** Error Code */
            error_code: string | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            state: components["schemas"]["BackgroundJobState"];
        };
        /**
         * WorkspaceTotalsOut
         * @description Four counts over the whole workspace.
         */
        WorkspaceTotalsOut: {
            /** Annotations */
            annotations: number;
            /** Assets */
            assets: number;
            /** Projects */
            projects: number;
            /** Releases */
            releases: number;
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
                /** @description Keep only assets in these states. Repeat the parameter per state. */
                progress?: components["schemas"]["AssetProgress"][] | null;
                /** @description `membership` is stored order; `confidence` is lowest model confidence first, unscored last, ties in membership order. */
                sort?: components["schemas"]["AssetSort"];
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
    pre_label_plan: {
        parameters: {
            query: {
                connection_id: string;
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
                    "application/json": components["schemas"]["PreLabelPlanOut"];
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
    pre_label_batch: {
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
                "application/json": components["schemas"]["PreLabelRequest"];
            };
        };
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
    get_home: {
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
                    "application/json": components["schemas"]["HomeOut"];
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
    check_connection_integrity: {
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
    download_connection_weights: {
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
    test_connection_endpoint: {
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
            /** @description An http connection's endpoint did not answer */
            502: {
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
    inference_download_size: {
        parameters: {
            query: {
                model_id: string;
                model_revision: string;
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
                    "application/json": components["schemas"]["DownloadSizeOut"];
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
    list_providers: {
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
                    "application/json": components["schemas"]["ProviderPage"];
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
    suggest_region: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SuggestRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuggestionOut"];
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
            /** @description An http connection's endpoint did not answer */
            502: {
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
    assign_job: {
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
                "application/json": components["schemas"]["JobAssign"];
            };
        };
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
    pre_label_project_batches: {
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
                "application/json": components["schemas"]["ProjectPreLabelRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectPreLabelOut"];
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
    list_blocking_assets: {
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
        requestBody: {
            content: {
                "application/json": components["schemas"]["SchemaVersionCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BlockingAssetPage"];
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
    get_schema_draft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                /** @description Which kind of work the draft belongs to. */
                kind: components["schemas"]["SchemaProvenance"];
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
                    "application/json": components["schemas"]["SchemaDraftOut"];
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
    save_schema_draft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                /** @description Which kind of work the draft belongs to. */
                kind: components["schemas"]["SchemaProvenance"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SchemaDraftBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SchemaDraftOut"];
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
    discard_schema_draft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                /** @description Which kind of work the draft belongs to. */
                kind: components["schemas"]["SchemaProvenance"];
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
    publish_schema_draft: {
        parameters: {
            query?: {
                /** @description Required when the new version narrows the labeling contract. */
                allow_destructive?: boolean;
            };
            header?: never;
            path: {
                project_id: string;
                /** @description Which kind of work the draft belongs to. */
                kind: components["schemas"]["SchemaProvenance"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SchemaDraftPublish"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SchemaPublicationOut"];
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
    preview_schema_change: {
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
                "application/json": components["schemas"]["SchemaVersionCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SchemaChangePreviewOut"];
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
                    "application/json": components["schemas"]["SchemaPublicationOut"];
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

/** A member of an open vocabulary, or a value a compatible release added after this build. */
export type OpenMember<A extends string> = A | (string & {});

/** The members this build compiled against, per vocabulary the contract may grow. */
export interface KnownMembers {
  AssetAction: "annotate" | "skip" | "restore" | "confirm" | "submit_for_review" | "accept" | "return_to_annotator";
  BatchAction: "approve" | "start" | "complete" | "repin" | "promote" | "create_correction" | "pre_label" | "edit_membership" | "delete";
  ConnectionAction: "download_weights" | "check_integrity" | "test_endpoint" | "update" | "delete";
  JobAction: "start" | "complete";
  ModelCapability: "point_suggest" | "text_detect";
  PreLabelExclusionReason: "no_producible_geometry" | "required_attribute";
  SuggestParameter: "detail";
}
