"""What this surface can actually do, as opposed to what the kernel permits.

``allowed_actions`` is declared by the kernel for every surface. The MCP layer
trims the actions it has no tool for, so an agent is never told to do something
it cannot call. REST, the CLI and the kernel keep the full list.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Final, TypeVar, cast

from visionset.kernel.domain import BatchAction

ALLOW_DESTRUCTIVE_ENV: Final = "VISIONSET_MCP_ALLOW_DESTRUCTIVE"
"""Set to ``1`` to advertise the destructive tools.

An environment variable rather than an argument, because ``main()`` takes none:
this server is started by ``visionset mcp`` as a subprocess whose transport *is*
stdin and stdout, so configuration travels the same channel the workspace does.
An agent cannot set it — it is read once, at import, in a process the agent did
not start.
"""

T = TypeVar("T", bound=Mapping[str, object])

NO_JOB_TOOL: Final = frozenset({"start"})
"""Job actions with no MCP tool: a job starts on the first write that touches it."""


def destructive_tools_allowed() -> bool:
    """Whether this process advertises the destructive tools.

    Read through a function rather than frozen into a constant so a test can
    ``monkeypatch.setenv`` and rebuild a registry; ``static_root()`` in
    ``server/main.py`` is the same seam for the same reason.
    """
    return os.environ.get(ALLOW_DESTRUCTIVE_ENV) == "1"


def mcp_job(document: T) -> T:
    """``document`` with the job actions this surface has no tool for removed."""
    actions = [a for a in cast(list[str], document["allowed_actions"]) if a not in NO_JOB_TOOL]
    return cast(T, {**document, "allowed_actions": actions})


def mcp_batch(document: T) -> T:
    """``document`` without ``delete`` unless ``delete_batch`` is registered."""
    actions = cast(list[str], document["allowed_actions"])
    if not destructive_tools_allowed():
        actions = [a for a in actions if a != BatchAction.DELETE.value]
    return cast(T, {**document, "allowed_actions": actions})
