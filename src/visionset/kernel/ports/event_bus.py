from collections.abc import Callable, Mapping
from typing import Protocol, runtime_checkable

Event = Mapping[str, object]


@runtime_checkable
class EventBus(Protocol):
    """In-process pub/sub for domain events (ingest progress, job updates, ...)."""

    def publish(self, topic: str, event: Event) -> None: ...

    def subscribe(self, topic: str, handler: Callable[[Event], None]) -> None: ...
