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
transformers, accelerate and huggingface_hub is inside a function — see
``_extra`` for why that is load-bearing rather than tidy — so a base install
starts a server, runs a worker and imports this module without the optional
runtime present. ``tests/architecture/test_optional_runtime.py`` proves it in a
fresh interpreter.

**There is no plugin registry, and resolution happens in two steps.** #418's
recorded decision is that adapters are instantiated from user-created model
connections and never from a bundled default, which makes ``InferenceConnection``
the registry: a row somebody wrote, naming a kind, a model and where it runs. A
provider discovered by entry point would have nothing to be instantiated *from*,
and a workspace could acquire the ability to predict through an unrelated ``pip
install`` — which is exactly what "VisionSet never downloads a model on its own"
exists to prevent. ``providers`` does the resolving: the connection's kind says
*where*, and the model's own config says *which family*, because a local
connection may hold a detector that answers words or a segmenter that answers
places and those are not interchangeable.

**What each surface reaches for.** ``fetch_weights`` is the download,
``suggest`` is one click's worth of interactive segmentation, and ``provider_for``
is the raw resolution underneath both. A surface serving clicks wants ``suggest``
and the pool behind it; anything building a provider per call is paying a model
load per request, which is the latency failure D5 on #424 exists to prevent.
"""

from __future__ import annotations

from visionset.inference._extra import EXTRA, INSTALL_COMMAND, MODULES, require
from visionset.inference.cache import (
    DEFAULT_EMBEDDING_CAPACITY,
    DEFAULT_PROVIDER_CAPACITY,
    BoundedCache,
)
from visionset.inference.masks import DEFAULT_DETAIL, narrowed, polygon_from
from visionset.inference.nms import DEFAULT_IOU_THRESHOLD, suppressed
from visionset.inference.providers import (
    DETECTOR_FAMILIES,
    SEGMENTER_FAMILIES,
    SUPPORTED_FAMILIES,
    ProviderPool,
    family_of,
    provider_for,
    resident,
)
from visionset.inference.sam_provider import LocalSamProvider
from visionset.inference.suggestions import suggest
from visionset.inference.transformers_provider import LocalTransformersProvider
from visionset.inference.weights import (
    DEFAULT_SIZE_CAPACITY,
    MODELS_DIRNAME,
    DownloadSizes,
    cache_root,
    download,
    download_size,
    fetch_weights,
    known_sizes,
    measure,
)

__all__ = [
    "DEFAULT_DETAIL",
    "DEFAULT_EMBEDDING_CAPACITY",
    "DEFAULT_IOU_THRESHOLD",
    "DEFAULT_PROVIDER_CAPACITY",
    "DEFAULT_SIZE_CAPACITY",
    "DETECTOR_FAMILIES",
    "EXTRA",
    "INSTALL_COMMAND",
    "MODELS_DIRNAME",
    "MODULES",
    "SEGMENTER_FAMILIES",
    "SUPPORTED_FAMILIES",
    "BoundedCache",
    "DownloadSizes",
    "LocalSamProvider",
    "LocalTransformersProvider",
    "ProviderPool",
    "cache_root",
    "download",
    "download_size",
    "family_of",
    "fetch_weights",
    "known_sizes",
    "measure",
    "narrowed",
    "polygon_from",
    "provider_for",
    "require",
    "resident",
    "suggest",
    "suppressed",
]
