# usage: from visionset.kernel.ports import ModelProvider
"""Asking a model what it sees, without knowing where the model is.

**This port used to be a placeholder and its own docstring said so.** Its whole
surface was ``predict(asset, schema) -> Sequence[Annotation]``, declared to fix a
name rather than designed, and it failed the test #418 sets — that every element
of the shape must hold for a runner in this process *and* for a service across a
network — in three separate ways. Each is answered below, and each answer is the
reason a line is written the way it is.

**Per asset -> per batch.** One call per image is the simplest thing locally and
the worst thing remotely: a hosted service pays a round trip for every picture.
:class:`~visionset.kernel.domain.PredictionRequest` therefore carries a tuple of
targets, and a local provider is free to loop over it. How *many* is the caller's
question and not the port's — the Phase 0 measurement recorded on #418 found
throughput falling as batch size rose on mixed-size images, so a caller on that
profile sends one target at a time and needs no port change to send more the day
it measures otherwise.

**A materialised sequence -> an iterator.** The old shape had a slow provider
blocking with nowhere to be and nothing to say. Yielding is the answer that costs
no transport assumption: a local provider yields after each image, a hosted one
yields as its batch comes back, and a caller that wants progress reports it
between yields with whatever channel it already has. Nothing here names a
``ProgressReporter``, a queue, a callback or a future — the port would then be
describing *how* the caller is organised, which is exactly the coupling that made
the old shape untenable.

**An ``Annotation`` -> an :class:`~visionset.kernel.domain.AssetPrediction`.**
A model produces a claim, not a label. An ``Annotation`` is schema-validated,
carries a ``schema_version`` and a ``job_id``, and is a thing that has been
*written*; making it the return type would oblige every provider to know which
schema version a batch pinned, which a remote one cannot and a local one should
not. So a provider answers in its own terms and the write gate turns that into
labels — which is the boundary #417 and #424 are both drawn on, and the reason
this port ships with no annotation writing anywhere near it.

## Discovery: there is no entry-point group, and that is the decision

``Importer`` and ``Exporter`` name the ``visionset.formats`` group because a
format is a *plugin*: a third-party distribution ships one and the product must
find it without knowing it exists. A provider is not that shape. The recorded
decision on #418 is that adapters are instantiated **from user-created model
connections** and never from a bundled default, which makes
``InferenceConnection`` the registry — a row somebody wrote, naming a kind, a
model and where it runs. A provider discovered by entry point would have nothing
to be instantiated *from*, and a workspace could acquire the ability to predict
by an unrelated ``pip install``, which is precisely what "VisionSet never
downloads a model on its own" exists to prevent.

So resolution is by :class:`~visionset.kernel.domain.ConnectionType`, in the
composition root, outside the kernel — ``visionset.inference`` — for the reason
``ReleaseService`` takes an ``Exporter`` instance rather than a format name: the
kernel may not import what would run.

## What a provider owes, and what it does not

- It **may** be asked for a prompt kind it cannot serve, and must refuse rather
  than approximate. A points-prompted model handed words has not been asked a
  harder question; it has been asked a different one.
- It **must** stamp every answer with the ``model_ref`` that produced it, because
  that string becomes an annotation's provenance and there is no later moment
  where it could be recovered.
- It owes **no** schema validation, no deduplication across calls, and no
  persistence. It also owes no thread safety: a provider is constructed by the
  code that is about to use it.
"""

from collections.abc import Iterator
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import AssetPrediction, PredictionRequest


@runtime_checkable
class ModelProvider(Protocol):
    """Something that can be asked what it sees in a batch of images.

    ``@runtime_checkable`` on ``Importer``'s terms: the composition root builds
    one and a test asserts the built thing satisfies the protocol, which is a
    check ``isinstance`` can make on an *instance* even though it cannot make it
    on a class carrying data members.
    """

    def predict(self, request: PredictionRequest) -> Iterator[AssetPrediction]:
        """Answer for each target in the request, in whatever order they finish.

        **Yields rather than returns**, which is what lets a caller report
        progress and stop early without this port knowing how either is done.
        A provider that has nothing to stream is free to compute everything first
        and yield the results one by one; the contract is the shape, not the
        laziness.

        Exactly one answer per target, and never more: a target that produced no
        regions answers with an empty ``regions`` tuple, because "found nothing"
        and "was not looked at" are different facts and a caller pairing answers
        to targets by count would silently conflate them.

        Raises:
            VisionSetError: the provider cannot serve this request — an unusable
                prompt kind, a model that is not present, a service that refused.
                A provider **must** raise from this tree rather than letting an
                implementation library's own exception out, so that every surface
                renders a sentence instead of a stack trace.
        """
        ...
