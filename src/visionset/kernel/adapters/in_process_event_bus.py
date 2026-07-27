"""Default EventBus adapter: synchronous, same-process, at-most-once delivery."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import cast

from visionset.kernel.domain import DomainEvent

#: The kernel's only logger, and the only place a swallowed subscriber failure
#: can surface. It is deliberately never configured here: a library that calls
#: ``basicConfig`` has taken a decision that belongs to the program embedding it,
#: so the CLI, the REST server and the MCP surface each set up handlers for
#: themselves and this module only reports.
_LOG = logging.getLogger(__name__)


class InProcessEventBus:
    """Delivers each event to the subscribers that asked for its type.

    Matching is ``isinstance``, so a subscription to
    :class:`~visionset.kernel.domain.events.DomainEvent` receives everything and
    one to a concrete event receives only that. Delivery order is **registration
    order** — not a promise about causality, just the only order that is
    reproducible, and worth stating so nobody infers a priority scheme from it.

    Subscribers are isolated: a handler that raises is logged with its traceback,
    the handlers registered after it still run, and :meth:`publish` returns
    normally. That is what keeps a bad subscriber from becoming a bad write —
    together with the services, which publish only once their transaction has
    committed.

    At-most-once, therefore, and by construction: the event a raising handler
    missed is not retried, not queued, and not stored. Wanting more than that
    means wanting a durable bus, which is a different adapter behind the same
    port.

    Holds no file handle, socket or thread, which is why ``WorkspaceService``
    creates one per open workspace and never closes it.
    """

    def __init__(self) -> None:
        self._subscribers: list[tuple[type[DomainEvent], Callable[[DomainEvent], None]]] = []

    def publish(self, event: DomainEvent) -> None:
        """Hand the event to every matching subscriber, in registration order."""
        # A snapshot, so a handler that subscribes while being called does not
        # mutate the list underneath the loop — and does not receive the event it
        # is being told about, which it has not asked for yet.
        for event_type, handler in list(self._subscribers):
            if not isinstance(event, event_type):
                continue
            try:
                handler(event)
            except Exception:
                # Never BaseException: a KeyboardInterrupt is the operator
                # talking, and swallowing it would make Ctrl-C depend on whether
                # an event happened to be in flight.
                _LOG.exception(
                    "subscriber %r raised on %s %s; the remaining subscribers still run "
                    "and the operation that emitted it is unaffected",
                    handler,
                    event.name,
                    event.id,
                )

    def subscribe[E: DomainEvent](self, event_type: type[E], handler: Callable[[E], None]) -> None:
        """Register ``handler`` for ``event_type`` and every subclass of it."""
        # A ``Callable[[BatchApproved], None]`` is not a ``Callable[[DomainEvent],
        # None]`` — parameters are contravariant, and a handler expecting the
        # narrower type would be unsound if handed the wider one. The cast is
        # honest because the ``isinstance`` gate in ``publish`` is what makes it
        # true: the pair is only ever used together.
        self._subscribers.append((event_type, cast(Callable[[DomainEvent], None], handler)))
