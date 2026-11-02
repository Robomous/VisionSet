"""What a connection says before any call: instructions, the workflow resource, identity."""

from __future__ import annotations

import re

import anyio
from mcp.client import Client

from visionset import __version__
from visionset.mcp._guide import INSTRUCTIONS, WORKFLOW, WORKFLOW_URI
from visionset.mcp.main import TOOLS, build_server


def _connect() -> tuple[str | None, str, str, list[str], str | None]:
    async def go() -> tuple[str | None, str, str, list[str], str | None]:
        async with Client(build_server()) as client:
            resources = (await client.list_resources()).resources
            read = await client.read_resource(WORKFLOW_URI)
            info = client.server_info
            tools = (await client.list_tools()).tools
            return (
                client.instructions,
                "" if info is None else info.version,
                getattr(read.contents[0], "text", ""),
                [str(r.uri) for r in resources],
                tools[0].title,
            )

    return anyio.run(go)


def test_a_cold_agent_gets_instructions_a_version_a_resource_and_titles() -> None:
    instructions, version, workflow, uris, title = _connect()
    assert instructions == INSTRUCTIONS
    assert version == __version__
    assert uris == [WORKFLOW_URI]
    assert workflow == WORKFLOW
    assert title == "Create project"


def test_the_guide_names_only_tools_that_exist() -> None:
    shipped = {tool.__name__ for tool, _ in TOOLS}
    named = set(re.findall(r"`([a-z]+(?:_[a-z]+)+)`", INSTRUCTIONS + WORKFLOW))
    # Parameters and codes in backticks are not tools; a tool name is registered.
    parameters = {"retry_with", "allowed_actions", "classification_tag", "isError"}
    assert named - parameters <= shipped, sorted(named - parameters - shipped)
