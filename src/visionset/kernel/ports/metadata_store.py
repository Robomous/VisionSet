from typing import Protocol, runtime_checkable


@runtime_checkable
class MetadataStore(Protocol):
    """Persistence for domain entities (projects, assets, annotations, ...).

    Only lifecycle management is defined today; entity-level operations land
    together with the table models in a later session.
    """

    def initialize(self) -> None:
        """Create the storage schema if it does not exist. Idempotent."""
        ...

    def close(self) -> None: ...
