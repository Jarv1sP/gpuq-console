# Production source: e6cce52

The `release/production-e6cce52` branch and `production-e6cce52` tag publish the Portal/CLI source for production revision `e6cce52256c2b5c18870533e9686750eb40ffd23`, deployed on 2026-10-10 at 12:57:54 UTC.

The production revision and public Git commit have different hashes because the public branch retains repository documentation, sample inventory, tests and node sources. Private configuration, runtime state, user data and generated client binaries are excluded. Node sources on this branch are not a statement of which node runtime is deployed.

Portal/CLI files come from the production snapshot. Build scripts include the matching native helper sources for Linux/Windows x64 and arm64; `npm ci --ignore-scripts` followed by `npm run build:client` rebuilds the standalone CLI. The verified Go toolchain is downloaded only during the build, or supplied through `GO`. Docker includes the new transitive Portal modules and native build inputs.

The public `main` development line remains separate. The cancellation fix in PR 273 is a later node-runtime change and is not part of this Portal/CLI deployment. Publishing this branch does not deploy services or alter existing jobs.
