# VisionSet documentation

Product and architecture docs land here. Start with the repo-root
[README](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md); the architecture
contracts (kernel purity, headless annotator) are described there and enforced in CI.

| Doc | Covers |
| --- | --- |
| [workspaces.md](workspaces.md) | The workspace on disk: layout, `init`/`open`, project-name uniqueness, and how services are composed |
| [persistence.md](persistence.md) | The metadata store: repositories, unit of work, table layout, migrations and `format_version` |
