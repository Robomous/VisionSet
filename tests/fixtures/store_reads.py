"""Counting what a unit of work reads, and the statements a store executes."""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID

from sqlalchemy import Engine, event


class _CountedRepository:
    def __init__(self, repository: Any, reads: Counter[UUID]) -> None:
        self._repository = repository
        self._reads = reads

    def get(self, entity_id: UUID) -> Any:
        self._reads[entity_id] += 1
        return self._repository.get(entity_id)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._repository, name)


class CountingUnitOfWork:
    """Delegates everything to ``uow``, counting ``assets.get`` and ``sources.get`` by id."""

    def __init__(self, uow: Any) -> None:
        self._uow = uow
        self.asset_reads: Counter[UUID] = Counter()
        self.source_reads: Counter[UUID] = Counter()

    @property
    def assets(self) -> _CountedRepository:
        return _CountedRepository(self._uow.assets, self.asset_reads)

    @property
    def sources(self) -> _CountedRepository:
        return _CountedRepository(self._uow.sources, self.source_reads)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._uow, name)


@contextmanager
def executed_statements() -> Iterator[list[str]]:
    """Every SQL statement any engine sends while the block runs, in order.

    An ``executemany`` is one entry, which is what makes this a measure of round
    trips rather than of rows.
    """
    statements: list[str] = []

    def record(*args: Any) -> None:
        statements.append(args[2])

    event.listen(Engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(Engine, "before_cursor_execute", record)
