# Experiment tracking

VisionSet can record its work as runs on an [MLflow](https://mlflow.org/) tracking server. It is
**off by default**, it is optional to install, and VisionSet works the same without it. Its job
database stays the record of what happened; a tracking server receives a copy of the parts listed
below, on a best-effort basis.

This page covers the adapter, its configuration, and what it records today: one run for each time
a [background job](background-jobs.md) is executed. Nothing else opens a run. Clicks and edits in
the UI, and work the CLI or MCP runs in its own process, are not tracked.

## Turning it on

```bash
pip install "visionset[mlflow]"
export VISIONSET_MLFLOW_ENABLED=true
export MLFLOW_TRACKING_URI=http://127.0.0.1:5000
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `VISIONSET_MLFLOW_ENABLED` | `false` | Turns tracking on. Takes `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`); unset or blank is off. Anything else is refused rather than read as off. |
| `VISIONSET_MLFLOW_EXPERIMENT` | `visionset` | The experiment runs are recorded under, 1 to 500 characters. Created on first use if the server does not have it. Checked only when tracking is on. |
| `MLFLOW_TRACKING_URI` | none | Where runs go. Required when tracking is on, and read only then. |

**A tracking URI alone never turns tracking on.** `MLFLOW_TRACKING_URI` is often set for other
tools on the same machine, so VisionSet reads it only after `VISIONSET_MLFLOW_ENABLED` says to.
With tracking off, VisionSet does not import the MLflow client, creates no client and opens no
connection.

The `mlflow` extra installs `mlflow-skinny`, which carries the client and the REST store. A tracking
server is an `http://` or `https://` URI. The skinny client cannot open a `sqlite://` or other
database store; install the full `mlflow` package if you point VisionSet at one. A `file://` store
(a local directory) is refused by MLflow itself unless `MLFLOW_ALLOW_FILE_STORE=true` is set.

### Authentication and TLS

VisionSet passes MLflow's own variables through untouched: `MLFLOW_TRACKING_USERNAME` and
`MLFLOW_TRACKING_PASSWORD`, `MLFLOW_TRACKING_TOKEN`, `MLFLOW_TRACKING_INSECURE_TLS`,
`MLFLOW_TRACKING_SERVER_CERT_PATH`, `MLFLOW_TRACKING_CLIENT_CERT_PATH`, and the rest the MLflow
documentation lists. Set them in the environment of the process that runs VisionSet.

**A URI carrying credentials is refused** (`https://user:password@host`). Put them in the
variables above instead, so they cannot reach a log line by way of the URI.

## When it is misconfigured

A configuration VisionSet cannot use is refused with `TRACKING_UNAVAILABLE`
([error codes](error-codes.md)), and the message names the remedy:

- `VISIONSET_MLFLOW_ENABLED` is set to something that is neither blank nor true or false;
- with tracking on, the experiment name is empty or longer than 500 characters;
- with tracking on, `MLFLOW_TRACKING_URI` is not set, carries credentials, carries a query string or
  fragment (put a token in `MLFLOW_TRACKING_TOKEN`), or names a store MLflow cannot open;
- with tracking on, the MLflow client is not installed. The message carries
  `pip install "visionset[mlflow]"`.

With tracking off, nothing but the flag is read, so nothing else can be refused. The message never
repeats the URI.

## When the server is down

Once tracking has started, delivery is best-effort. A server that is down, slow or refusing
requests produces a warning on the `visionset.tracking` logger and never fails the work being
tracked. A run that could not be started is skipped as a whole: nothing further is sent for it.

The warning names the operation and the exception class, plus MLflow's error code where there is
one (`RESOURCE_DOES_NOT_EXIST`, for instance). It never carries the exception's text, which can
contain the URI or a local path.

**No log line names the server.** urllib3, which MLflow sends its requests through, names the host
and port when it connects and when it retries. While tracking is enabled, VisionSet attaches a filter
to urllib3's connection, pool and retry loggers, and to the handler MLflow installs on its own
`mlflow` logger, that rewrites the tracking URI, its host, its port and its path to
`<tracking server>` in any record that carries them. It touches no other logger and none of your
handlers. A handler you attach to the `mlflow` logger yourself is outside it; so is
`MLFLOW_CONFIGURE_LOGGING=false`, which hands MLflow's records to your root logger.

MLflow's own defaults retry a failed request for several minutes. VisionSet sets shorter ones before
it imports the client, and only where the variable is not already set, so your value always wins:

| Variable | VisionSet's default | MLflow's default |
| --- | --- | --- |
| `MLFLOW_HTTP_REQUEST_TIMEOUT` | `5` seconds | `120` |
| `MLFLOW_HTTP_REQUEST_MAX_RETRIES` | `1` | `7` |
| `MLFLOW_HTTP_REQUEST_BACKOFF_FACTOR` | `1` | `2` |

## What is sent

A run is opened through `MlflowClient` with an explicit run id. VisionSet uses no autologging and no
active run, and never calls `mlflow.set_tracking_uri`, so it does not change what other MLflow code
in the same process does.

Each run carries the name, parameters, metrics and tags VisionSet passes to it, and nothing MLflow
adds on its own beyond its client version header and a start time. The requests are a lookup of the
experiment by name (and its creation, the first time), the run's creation, one batch per call that
records parameters, metrics or tags, one request that records the run's dataset inputs when it
has any ([release lineage](#release-lineage)), and, to end the run, a read of the run followed by
its update:
MLflow's client reads a run back before marking it finished. Closing a run its worker left open
([runs left open](#runs-left-open)) adds one search of the experiment for running runs carrying a
given VisionSet id; the search names only that id, `visionset.execution_source`, and the `RUNNING`
status. The user is recorded as
`unknown`: VisionSet does not send the operating-system user name, the host name or the working
directory.

What the tracked operations put in those fields is listed under
[background jobs](#background-jobs), and follows these rules: no images, annotations, model weights,
export archives, credentials or absolute paths, and no artifact uploads.

**Telemetry and printing.** VisionSet sets `MLFLOW_DISABLE_TELEMETRY=true`,
`MLFLOW_DISABLE_AGENT_HINT=true` and `MLFLOW_SUPPRESS_PRINTING_URL_TO_STDOUT=true` before it imports
the client, so the MLflow SDK sends no usage telemetry of its own and does not print a link to each
finished run, with the server's address in it, to standard output. As with the timeouts, a value you
set yourself is kept.

## Across processes

Background jobs run in worker processes started with `spawn` ([background jobs](background-jobs.md)).
A tracker is never passed to one. What crosses a process boundary is `TrackingSettings`, which holds
only `mlflow_enabled` and `mlflow_experiment`. A worker inherits the environment and builds its own
client from the same variables, so the tracking URI and credentials are never written into a job
payload or a log.

## Background jobs

**One run per execution attempt.** A run is opened when a worker starts a job it was handed, not
when the job is queued, and it is closed when that attempt ends. A job retried after a failure is a
new job ([background jobs](background-jobs.md)), so it gets a run of its own; so does a job the
server re-queues after a crash. Runs belong to one attempt each and are correlated by the tags
below, never by an active run: every call names its run by id, so concurrent workers cannot write
into each other's runs.

A job that never reaches a worker opens no run: one cancelled while queued, one whose type nothing
runs, and one the pool would not accept.

### How a run ends

| Job state | Run status | `visionset.job_state` |
| --- | --- | --- |
| `succeeded` | `FINISHED` | `succeeded` |
| `failed` | `FAILED` | `failed` |
| `cancelled` (stopped on request) | `KILLED` | `cancelled` |

The job database is the record. A run reports what the worker saw; if the server cannot write the
job's row afterwards, the row and the run can disagree, and the row is right.

### What a run carries

The run is named after the job type (`annotation.pre_label`, for instance), or `background_job` if
the type is not a plain lower-case name. Everything else is from
this list, and a value that is missing or not of the expected shape is left out rather than filled
in: there are no zero counts standing in for unknowns.

| Kind | Key | When |
| --- | --- | --- |
| Tag | `visionset.job_id` | Always |
| Tag | `visionset.job_type` | When the type is a plain lower-case name, which every shipped type is. |
| Tag | `visionset.execution_id` | Always. A fresh id for each attempt the dispatcher hands to a worker. |
| Tag | `visionset.attempt` | Always. How many times the job's row has been claimed. |
| Tag | `visionset.execution_source` | Always `background_job`. |
| Tag | `visionset.version` | The installed VisionSet version. No build commit is recorded: the package does not carry one. |
| Tag | `visionset.batch_id`, `visionset.connection_id`, `visionset.annotation_job_id`, `visionset.release_id`, `visionset.ingest_job_id` | When the job names them, and only as ids. |
| Tag | `visionset.job_state` | When the attempt ends. |
| Tag | `visionset.error_class`, `visionset.error_code` | When it fails: the exception's class name and its [error code](error-codes.md) if it has one. Never the message. |
| Tag | `visionset.reconciled` | When the run was ended by someone other than its worker; see below. |
| Metric | `duration_seconds` | Always. How long the worker spent on the job, on a monotonic clock. It excludes time spent queued and time spent talking to the tracking server. |
| Metric | `processed_count`, `failures_count`, `total_count` | When the attempt returns and the job reported progress. `total_count` only when the total was known. Not sent for a failed attempt, whose job row keeps no counts either. A weight download reports bytes instead; see below. |

Pre-labeling adds what it was asked for and what it did:

| Kind | Key | When |
| --- | --- | --- |
| Parameter | `minimum_confidence` | A number from 0 to 1. |
| Parameter | `replace_model_labels` | `True` or `False`. |
| Parameter | `requested_geometries` | When the launch narrowed the shapes, as a sorted, comma-separated list. Absent means every shape the model produces. |
| Parameter | `model_id`, `model_revision` | When the run succeeded and the model that answered is named as `<id>@<40-character commit>`. A model named any other way, including by a path or an address, is left out. The provider is not recorded. |
| Metric | `annotations_written_count`, `annotations_replaced_count`, `assets_skipped_count`, `regions_discarded_count`, `regions_out_of_bounds_count` | When the run returns. |

These counts are what the job did, not how good the model is: none of them is an accuracy figure.

"When the run succeeded" below means the row behind it was read, which happens only for an attempt
that returned without being cancelled; see [reading the rows behind a run](#reading-the-rows-behind-a-run).

#### Export

An export (`export.release`) adds what it was asked for, the release it read, and what it wrote. The
archive is never uploaded, and neither its path nor the release's tag or dataset name is sent.

| Kind | Key | When |
| --- | --- | --- |
| Tag | `visionset.release_id` | Always, from the job. |
| Tag | `visionset.dataset_id` | When the run succeeded. The dataset the release belongs to, as an id. |
| Parameter | `export_format`, `export_target` | The format's and the target's own names, when they are plain lower-case names. `export_target` only when the export named a target. |
| Parameter | `allow_lossy` | `True` or `False`. |
| Parameter | `recipe_applied` | `True` when the export ran a pre-processing recipe. The recipe's name is not sent. |
| Parameter | `recipe_hash` | When the attempt returns after running a recipe: the 64-character hash of the recipe's content. |
| Parameter | `release_manifest_hash`, `release_schema_version` | When the run succeeded: the release's manifest hash (64 hexadecimal characters) and the label schema version it was published under. |
| Metric | `processed_count`, `total_count`, `failures_count` | When the attempt returns. Files written, counted after the format plugin returned. |
| Metric | `output_bytes` | When the attempt returns. The bytes of those files, before archiving. |
| Metric | `source_image_count`, `augmented_image_count` | When the attempt returns. Images the plugin was handed from the release, and augmented variants a recipe added. |
| Dataset input | the release | When the run succeeded; see [release lineage](#release-lineage). |

#### Ingest

An ingest (`ingest.resume`) adds the counters of its ingest run as that run's own record holds them,
read once when the job returns. The batch name, the source's location, file names and per-file errors
are not sent.

| Kind | Key | When |
| --- | --- | --- |
| Tag | `visionset.ingest_job_id` | Always, from the job. |
| Tag | `visionset.source_id`, `visionset.batch_id` | When the run succeeded, as ids. `visionset.batch_id` only when the run reached a batch. |
| Metric | `processed_count`, `total_count`, `failures_count` | When the run succeeded. Entries dealt with, entries in the source, and files that could not be read. `total_count` only when it was known. |
| Metric | `asset_count`, `created_asset_count` | When the attempt returns. Assets this run put in its batch, and how many of them were new to the project. |

#### Model weight download

A weight download (`inference.download_weights`) records which model was fetched, never the weights,
the cache directory, the connection's name or an address the files came from. No model is
registered with MLflow.

| Kind | Key | When |
| --- | --- | --- |
| Tag | `visionset.connection_id` | Always, from the job. |
| Parameter | `model_id` | When the attempt returns and the id is `<name>` or `<owner>/<name>`. A path or an address is left out. |
| Parameter | `model_revision` | With `model_id`, when the revision is a 40-character commit. |
| Parameter | `model_provider` | When the run succeeded and the connection records which installed driver serves it. |
| Parameter | `model_family` | When the run succeeded and the downloaded configuration declared the kind of model. |
| Metric | `bytes_done`, `bytes_total` | When the attempt returns and reported progress. Bytes of the revision on disk at the end, and its published size when it could be read. These replace `processed_count`, `total_count` and `failures_count` for this job type. |

#### Release lineage

Publishing a release is not a background job, so it opens no run. A release appears in the runs that
consume it: a succeeded export records it as an MLflow dataset input, which the MLflow UI lists under
the run's datasets. It is an identity, not a copy: nothing in the release, its manifest, its images
or its labels is uploaded.

| Field | Value |
| --- | --- |
| Name | `visionset-release-<release id>` |
| Digest | The first 32 characters of the manifest hash. MLflow does not accept a longer digest; the whole hash is the `release_manifest_hash` parameter. |
| Source type | `visionset_release` |
| Source | `{"dataset_id": "<id>", "release_id": "<id>"}` |
| Profile | `{"annotation_count": n, "asset_count": n, "manifest_hash": "<hash>", "schema_version": n}` |
| Input tag | `mlflow.data.context` = `export` |

#### Reading the rows behind a run

Export, ingest and weight-download runs read one row each, by the id their job names, when the job
returns: the release, the ingest run, or the connection. The worker reads it from its own workspace
after the job's clock has stopped, so it is not part of `duration_seconds`, and nothing is scanned. A
row that cannot be read is left out of the run with a warning, and the job's result is unchanged.
Nothing is read for a failed or cancelled attempt.

### Delivery never holds a job

A worker does not wait for the tracking server. Opening and closing a run are queued for a thread in
the worker's own process, which sends them in order while the job runs on. A slow, failing or
unreachable server therefore cannot delay a job or change its outcome; at worst a run is missing or
incomplete, with a warning on the `visionset.tracking` logger.

The one thing a worker does itself is build its client, once, before its first tracked job: that
imports MLflow and sends nothing. It happens before the job's clock starts, so it is not counted in
`duration_seconds`.

- If 64 or more deliveries are waiting in one process, a new attempt is not tracked at all, rather
  than letting the queue grow without bound.
- A worker that exits, for instance when the server stops, waits up to 10 seconds for its queued
  deliveries and then gives them up.
- When tracking cannot be set up in a process (the client is missing, or `MLFLOW_TRACKING_URI` is
  absent or refused), that process logs the reason once and tracks nothing. Jobs run as usual. An
  unreadable `VISIONSET_MLFLOW_ENABLED` is logged by the server at startup, and jobs then run
  untracked.

### Runs left open

A run is closed by the worker that opened it. When the worker cannot close it, VisionSet tries once
to close it from elsewhere, with status `FAILED` and a `visionset.reconciled` tag naming why:

| `visionset.reconciled` | What happened |
| --- | --- |
| `worker_lost` | The worker process died during the job. The dispatcher fails the job and then looks for a running run with that attempt's `visionset.execution_id`. |
| `server_restart` | The server was killed or crashed while the job was running (a graceful stop waits for running jobs). At the next start, the sweep that fails the job also looks for running runs with its `visionset.job_id`. |

This is best effort, and a run can stay `RUNNING` on the tracking server for good:

- when the tracking server cannot be reached at the moment of the lookup; nothing retries it later;
- when a worker gives up on queued deliveries at exit, because its job settled normally and nothing
  looks for its run afterwards;
- when a run's own end could not be delivered, for the same reason.

It can also close a run twice. A worker that outlives a killed server can still close its own run
while the next server closes it as `server_restart`, and when a pool breaks, its other workers can be
closing their runs as the dispatcher fails them. The run then ends up with whichever status arrived
last, and can carry both `visionset.reconciled` and a `visionset.job_state` other than `failed`.
The job's row is still the answer.

Treat a `RUNNING` run with no live job behind it as abandoned, and read the job's state from
VisionSet.
