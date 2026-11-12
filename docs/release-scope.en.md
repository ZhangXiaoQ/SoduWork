# First release scope

[简体中文](release-scope.md) · **English** · [Documentation](README.md)

Project copyright is attributed to **MDiRi**. See the root [LICENSE](../LICENSE).

The public source includes the desktop client, Hub, management UI, Runner source, multi-platform source launchers, and generic Docker self-hosting. It retains project-owned office, task, MCP, and capability-authoring guides, generic workflows, isolation checks, and migration tests.

Excluded from this distribution:

- Third-party skill bundles and their display metadata, and upstream platform-plugin reference snapshots.
- Mobile applications, internal product and architecture records, original brand design files, and validation process material.
- Non-public business plugins, applications, and their dedicated adapters, integration scripts, prompts, and assets.
- Business-content synchronization and demo-data seeding tools.
- Company cluster configuration, deployment pipelines, signing uploads, scheduled backups, and server rollback operations.

Generic update-signing and compatibility tools remain. Private keys, upload credentials, and company deployment configuration are excluded.

[PUBLIC-SOURCE.json](../tools/distribution/PUBLIC-SOURCE.json) and source checks define the file boundary. Generic model APIs and executor compatibility such as Codex do not imply bundled commercial skills; users supply their own services and permissions. Retained UI, terminal, and model runtime dependencies carry their original licenses.

## Runtime and data

Local source mode uses isolated SQLite storage and a dedicated desktop profile, listening on loopback by default. It does not load the checkout's `.env`, business databases, or existing model credentials. Model providers and optional execution agents need separate configuration.

Stop the service and back up the complete data directory before updates. Restore matching source and data backups together when rolling back. Docker team deployments need their own HTTPS, database backups, and access controls; local source mode is not a production deployment.

## Source and installers

Desktop installers, native runtimes, third-party models, imported plugins, and container images each need their own provenance, licensing, and runtime validation. Passing the source manifest check does not authorize distribution of those artifacts.

See the [GitHub workflow guide](../.github/RELEASE.md) for source, Client and Hub pipelines. Client and Hub publication requires preflight checks for distribution scope, third-party evidence and the applicable platform acceptance requirements. Desktop upgrades require previous-installer baselines. Workflow source does not establish publication clearance or a successful hosted run.

Initialize a public repository from a verified source ZIP, or squash the reviewed source into the public branch. Private development history, old tags, and previous artifacts are outside scope; do not turn the original development repository public. `tools/export_source.py` exports only the current committed tree, generates `tools/distribution/SOURCE-MANIFEST.json` from the archived files, records the source commit, and verifies the resulting ZIP. The manifest is an export artifact and must not be committed to Git. The archive omits Git history, uncommitted changes, untracked files, and dependency caches.

Report only the platforms actually tested. Windows checks do not replace native macOS/Linux validation, and synthetic-data checks do not establish real-model or production acceptance.
