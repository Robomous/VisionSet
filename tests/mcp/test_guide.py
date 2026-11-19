"""What a connection says before any call: instructions, the workflow resource, identity."""

from __future__ import annotations

import re

import anyio
from mcp.client import Client

from visionset import __version__
from visionset.mcp._guide import INSTRUCTIONS, WORKFLOW, WORKFLOW_URI
from visionset.mcp._topics import TOPICS
from visionset.mcp.main import TOOLS, build_server

MAX_DESCRIPTION = 1500


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
    assert uris[0] == WORKFLOW_URI
    assert workflow == WORKFLOW
    assert title == "Create project"


def test_the_guide_names_only_tools_that_exist() -> None:
    shipped = {tool.__name__ for tool, _ in TOOLS}
    named = set(re.findall(r"`([a-z]+(?:_[a-z]+)+)`", INSTRUCTIONS + WORKFLOW))
    # Parameters and codes in backticks are not tools; a tool name is registered.
    parameters = {"retry_with", "allowed_actions", "classification_tag", "isError", "is_refused"}
    assert named - parameters <= shipped, sorted(named - parameters - shipped)


def _uris_mentioned(text: str) -> set[str]:
    return set(re.findall(r"visionset://[a-z-]+", text))


def test_every_tool_description_is_short_enough_to_read_every_session() -> None:
    async def go() -> list[tuple[str, int]]:
        listed = await build_server(allow_destructive=True).list_tools()
        return [(tool.name, len(tool.description or "")) for tool in listed]

    too_long = [(name, size) for name, size in anyio.run(go) if size > MAX_DESCRIPTION]
    assert not too_long, too_long


def test_every_resource_the_listing_points_at_is_served() -> None:
    async def go() -> tuple[str, set[str]]:
        built = build_server(allow_destructive=True)
        described = "".join(tool.description or "" for tool in await built.list_tools())
        async with Client(built) as client:
            served = {str(r.uri) for r in (await client.list_resources()).resources}
        return described, served

    described, served = anyio.run(go)
    mentioned = _uris_mentioned(described + INSTRUCTIONS + WORKFLOW)
    assert mentioned and mentioned <= served, sorted(mentioned - served)
    assert {topic.uri for topic in TOPICS} <= served


def test_a_topic_resource_is_served_verbatim() -> None:
    async def go() -> list[str]:
        async with Client(build_server()) as client:
            return [
                getattr(((await client.read_resource(t.uri)).contents[0]), "text", "")
                for t in TOPICS
            ]

    assert anyio.run(go) == [topic.text for topic in TOPICS]


def test_both_annotation_writes_say_an_update_clears_an_unsent_visibility() -> None:
    async def go() -> dict[str, str]:
        listed = await build_server().list_tools()
        return {tool.name: tool.description or "" for tool in listed}

    described = anyio.run(go)
    geometry = next(t.text for t in TOPICS if t.uri == "visionset://annotation-geometry")
    for name in ("add_annotations", "update_annotations"):
        assert "visibility" in described[name]
        assert "visionset://annotation-geometry" in described[name]
    assert "resend it" in described["update_annotations"]
    assert "stored visibility is cleared" in geometry
    assert "`0` unlabeled" in geometry
