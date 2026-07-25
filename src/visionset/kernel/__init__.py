"""VisionSet kernel — hexagonal core.

Pure domain models, ports (``typing.Protocol`` interfaces), and default adapters.
This package must stay framework-free: no FastAPI, Typer, MCP, or uvicorn imports.
The boundary is machine-enforced by import-linter contracts (see pyproject.toml)
and by the architecture tests in ``tests/architecture/``.
"""
