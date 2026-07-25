from typing import Protocol, runtime_checkable


@runtime_checkable
class AuthProvider(Protocol):
    """Token verification. Delivery layers (server/CLI/MCP) depend on this port."""

    def verify(self, token: str) -> bool: ...
