"""A unit of work that counts which assets and sources were read from it."""

from __future__ import annotations

from collections import Counter
from typing import Any
from uuid import UUID


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
