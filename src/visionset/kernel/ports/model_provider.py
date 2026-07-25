from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import Annotation, AnnotationSchema, Asset


@runtime_checkable
class ModelProvider(Protocol):
    """Pre-annotation via models (Phase 3 — declared now to fix the port surface).

    Returned annotations must carry ``provenance='model'`` and a ``model_ref``.
    """

    def predict(self, asset: Asset, schema: AnnotationSchema) -> Sequence[Annotation]: ...
