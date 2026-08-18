# usage: from visionset.inference import provider_for, fetch_weights, suggest
"""The composition root for inference: a connection in, a ``ModelProvider`` out.

**A sibling of ``visionset.formats``, ``visionset.wire`` and ``visionset.jobs``,
and it is here for the same reason each of those is.** Running a model means
torch and transformers, and ``visionset.kernel`` may import neither — the port
describes the protocol and the kernel must stay implementable on a machine that
could not run anything. So the code that turns a configuration row into a running
model cannot live in the kernel, and it must not live in a delivery package
either: the CLI, the API and a background worker all need it, and shared logic
moves *down*, never sideways. One package above the kernel and beside the other
three is the only place left, and the import-linter contracts say so out loud.

**Importing this package imports nothing heavy.** Every reference to torch,
transformers, accelerate and huggingface_hub is inside a function, and
torchvision — which nothing here names, and ``transformers`` imports for us — is
held to the same line. See ``_extra`` for why that is load-bearing rather than
tidy: a base install starts a server, runs a worker and imports this module
without the optional runtime present, and
``tests/architecture/test_optional_runtime.py`` proves it in a fresh interpreter.

**Drivers are discovered, and resolution still happens in two steps.**
``registry`` scans the ``visionset.providers`` entry-point group for ``Provider``
descriptors, so a third-party driver is found without this build knowing it
exists. An adapter is still instantiated from a user-created connection, which
remains the registry of what may be run: installing a driver fetches nothing and
loads nothing — it becomes reachable, and no model becomes present. ``providers``
does the resolving: the connection's kind says *where*, and the model's own config
says *which family*, because a local connection may hold a detector that answers
words or a segmenter that answers places and those are not interchangeable.

**One environment variable is set as this module is read**, and it is the only
side effect importing this package has. ``PYTORCH_ENABLE_MPS_FALLBACK`` is what
lets an operator Metal has not implemented run on the CPU instead of raising, and
the array library reads it while it initialises rather than when such an operator
is reached — so by the time a connection has been resolved to a device it is
already too late to set. This module is the earliest place that is certain to be
read before torch is imported anywhere in the package, which is what makes it the
right place despite the setting having nothing to do with composition. It costs
one dictionary write on every machine, does nothing at all on a machine with no
Metal, and ``setdefault`` leaves an operator who set it to ``0`` alone.

**What each surface reaches for.** ``fetch_weights`` is the download,
``check_integrity`` is the full re-read that tells damage from completeness,
``suggest`` is one click's worth of interactive segmentation, and ``provider_for``
is the raw resolution underneath both. A surface serving clicks wants ``suggest``
and the pool behind it; anything building a provider per call pays a model load
per request, which is the latency failure the caching exists to prevent.
"""

from __future__ import annotations

from visionset.inference._device import MPS_FALLBACK_VARIABLE, enable_mps_fallback
from visionset.inference._extra import EXTRA, INSTALL_COMMAND, MODULES, require
from visionset.inference.cache import (
    DEFAULT_EMBEDDING_CAPACITY,
    DEFAULT_PROVIDER_CAPACITY,
    BoundedCache,
)
from visionset.inference.families import capabilities_of, family_of
from visionset.inference.integrity import (
    READ_CHUNK,
    Digest,
    IntegrityReport,
    PublishedDigest,
    check_integrity,
    digest_of,
    published_digests,
    purge,
)
from visionset.inference.masks import (
    EPSILON,
    MINIMUM_FRAGMENT_SHARE,
    MINIMUM_TOLERANCE,
    Piece,
    Shaped,
    components,
    contour,
    filled,
    polygon_at,
    shapes_from,
    simplified,
    tolerance_for,
)
from visionset.inference.nms import DEFAULT_IOU_THRESHOLD, suppressed
from visionset.inference.prelabel import (
    DEFAULT_MINIMUM_CONFIDENCE,
    PreLabelOutcome,
    detectable_classes,
    no_detectable_class_message,
    pre_label,
    require_detectable_schema,
    unsupported_prompt_message,
)
from visionset.inference.providers import ProviderPool, not_set_up_message, provider_for, resident
from visionset.inference.registry import (
    GROUP,
    Discovery,
    Skipped,
    capabilities,
    families_served,
    installed,
    registered,
    reset,
    serving,
)
from visionset.inference.sam_provider import LocalSamProvider, SamProvider
from visionset.inference.stub_provider import (
    STUB_FAMILY,
    STUB_MODEL_ID,
    StubProvider,
    StubSegmenter,
)
from visionset.inference.suggestions import Suggestion, suggest
from visionset.inference.transformers_provider import (
    GroundingDinoProvider,
    LocalTransformersProvider,
)
from visionset.inference.weights import (
    DEFAULT_SIZE_CAPACITY,
    MODELS_DIRNAME,
    DownloadSizes,
    HuggingFaceWeights,
    cache_root,
    download,
    download_size,
    fetch_weights,
    known_sizes,
    measure,
    with_families,
)

enable_mps_fallback()

__all__ = [
    "GROUP",
    "Discovery",
    "Skipped",
    "GroundingDinoProvider",
    "HuggingFaceWeights",
    "SamProvider",
    "StubProvider",
    "capabilities",
    "families_served",
    "installed",
    "registered",
    "reset",
    "serving",
    "EPSILON",
    "MPS_FALLBACK_VARIABLE",
    "enable_mps_fallback",
    "DEFAULT_EMBEDDING_CAPACITY",
    "DEFAULT_IOU_THRESHOLD",
    "DEFAULT_MINIMUM_CONFIDENCE",
    "DEFAULT_PROVIDER_CAPACITY",
    "DEFAULT_SIZE_CAPACITY",
    "EXTRA",
    "INSTALL_COMMAND",
    "MODELS_DIRNAME",
    "MODULES",
    "BoundedCache",
    "DownloadSizes",
    "LocalSamProvider",
    "LocalTransformersProvider",
    "PreLabelOutcome",
    "ProviderPool",
    "cache_root",
    "capabilities_of",
    "check_integrity",
    "detectable_classes",
    "digest_of",
    "download",
    "download_size",
    "family_of",
    "fetch_weights",
    "Digest",
    "IntegrityReport",
    "PublishedDigest",
    "READ_CHUNK",
    "known_sizes",
    "measure",
    "no_detectable_class_message",
    "not_set_up_message",
    "published_digests",
    "purge",
    "MINIMUM_FRAGMENT_SHARE",
    "MINIMUM_TOLERANCE",
    "Piece",
    "Shaped",
    "STUB_FAMILY",
    "STUB_MODEL_ID",
    "StubSegmenter",
    "Suggestion",
    "components",
    "contour",
    "filled",
    "polygon_at",
    "shapes_from",
    "simplified",
    "tolerance_for",
    "pre_label",
    "provider_for",
    "require",
    "require_detectable_schema",
    "resident",
    "suggest",
    "suppressed",
    "unsupported_prompt_message",
    "with_families",
]
