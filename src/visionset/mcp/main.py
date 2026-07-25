"""MCP server over stdio. Run with: python -m visionset.mcp.main

Every tool is a stub returning a structured `not_implemented` error until the
kernel SDK lands. Convention (starts now): tools that mutate or write anything
declare `confirm: bool = False` and refuse to act while it is false.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

server = FastMCP("visionset")


def _not_implemented(tool: str) -> dict[str, Any]:
    return {
        "error": {
            "code": "not_implemented",
            "message": f"'{tool}' is not implemented yet; the kernel SDK lands in a later session.",
        }
    }


def _confirmation_required(tool: str) -> dict[str, Any]:
    return {
        "error": {
            "code": "confirmation_required",
            "message": f"'{tool}' mutates state; call again with confirm=true to proceed.",
        }
    }


# --- read-only tools ---------------------------------------------------------


@server.tool()
def list_projects() -> dict[str, Any]:
    """List all projects in the workspace."""
    return _not_implemented("list_projects")


@server.tool()
def get_project_status(project_id: str) -> dict[str, Any]:
    """Get the status summary of a project."""
    return _not_implemented("get_project_status")


@server.tool()
def get_schema(project_id: str) -> dict[str, Any]:
    """Get the current annotation schema of a project."""
    return _not_implemented("get_schema")


@server.tool()
def get_ingest_progress(ingest_job_id: str) -> dict[str, Any]:
    """Get the progress of an ingest job."""
    return _not_implemented("get_ingest_progress")


@server.tool()
def list_jobs(project_id: str) -> dict[str, Any]:
    """List annotation jobs in a project."""
    return _not_implemented("list_jobs")


@server.tool()
def get_annotation_progress(job_id: str) -> dict[str, Any]:
    """Get per-asset annotation progress for a job."""
    return _not_implemented("get_annotation_progress")


@server.tool()
def dataset_stats(dataset_id: str) -> dict[str, Any]:
    """Get statistics (class balance, counts) for a dataset."""
    return _not_implemented("dataset_stats")


# --- mutating tools: the confirm-parameter convention starts here ------------


@server.tool()
def create_project(name: str, confirm: bool = False) -> dict[str, Any]:
    """Create a new project. Requires confirm=true."""
    if not confirm:
        return _confirmation_required("create_project")
    return _not_implemented("create_project")


@server.tool()
def ingest_source(project_id: str, uri: str, confirm: bool = False) -> dict[str, Any]:
    """Ingest a source (e.g. a local folder) into a project. Requires confirm=true."""
    if not confirm:
        return _confirmation_required("ingest_source")
    return _not_implemented("ingest_source")


@server.tool()
def partition_batch(batch_id: str, task_count: int, confirm: bool = False) -> dict[str, Any]:
    """Partition a batch into task groups. Requires confirm=true."""
    if not confirm:
        return _confirmation_required("partition_batch")
    return _not_implemented("partition_batch")


@server.tool()
def add_annotations(
    job_id: str, annotations: list[dict[str, Any]], confirm: bool = False
) -> dict[str, Any]:
    """Add annotations to a job (provenance will be 'model' or 'import'). Requires confirm=true."""
    if not confirm:
        return _confirmation_required("add_annotations")
    return _not_implemented("add_annotations")


@server.tool()
def publish_release(dataset_id: str, tag: str, confirm: bool = False) -> dict[str, Any]:
    """Publish an immutable release of a dataset. Requires confirm=true."""
    if not confirm:
        return _confirmation_required("publish_release")
    return _not_implemented("publish_release")


@server.tool()
def export_release(
    release_id: str, format_name: str, dest: str, confirm: bool = False
) -> dict[str, Any]:
    """Export a release to disk in the given format. Requires confirm=true."""
    if not confirm:
        return _confirmation_required("export_release")
    return _not_implemented("export_release")


def main() -> None:
    server.run()  # stdio transport by default


if __name__ == "__main__":
    main()
