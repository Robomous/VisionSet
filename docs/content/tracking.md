# Experiment tracking

VisionSet can record its work as runs on an [MLflow](https://mlflow.org/) tracking server. It is
**off by default**, it is optional to install, and VisionSet works the same without it. Its job
database stays the record of what happened; a tracking server receives a copy of the parts listed
below, on a best-effort basis.

This page covers the adapter and its configuration. Which operations open a run is not decided
here: until a later change instruments them, an enabled tracker records nothing on its own.

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
records parameters, metrics or tags, and, to end the run, a read of the run followed by its update:
MLflow's client reads a run back before marking it finished. The user is recorded as
`unknown`: VisionSet does not send the operating-system user name, the host name or the working
directory.

What the tracked operations put in those fields is decided by the change that instruments each
one, under these rules: no images, annotations, model weights, export archives, credentials or
absolute paths, and no artifact uploads.

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
