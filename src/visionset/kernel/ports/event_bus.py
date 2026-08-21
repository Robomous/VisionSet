from collections.abc import Callable
from typing import Protocol, runtime_checkable

from visionset.kernel.domain import DomainEvent


@runtime_checkable
class EventBus(Protocol):
    """In-process pub/sub for domain events. Synchronous, and at-most-once.

    Subscriptions are by **type**, not by topic string: ``subscribe(BatchApproved,
    handler)`` narrows what the handler is handed, and ``subscribe(DomainEvent,
    handler)`` is the catch-all, because an implementation matches with
    ``isinstance``. A topic string would put the same information somewhere the
    type checker cannot read it.

    Two rules an implementation owes its callers, and ``docs/content/events.md`` says why
    each one is the way it is:

    - **A subscriber cannot break the emitter.** An exception out of a handler is
      caught and reported, the remaining handlers still run, and ``publish``
      returns normally. Services publish *after* their transaction has committed,
      so by then there is nothing left to roll back either.
    - **At most once.** No retries, no queue, no persistence. An event whose
      subscriber raised is gone, and so is one the process died before
      delivering. Anything needing more than that wants a durable bus, which this
      port can front later without its callers changing.
    """

    def publish(self, event: DomainEvent) -> None: ...

    def subscribe[E: DomainEvent](
        self, event_type: type[E], handler: Callable[[E], None]
    ) -> None: ...
