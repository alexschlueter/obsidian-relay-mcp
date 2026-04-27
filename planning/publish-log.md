# Publish Preparation Log

## 2026-04-26

- Started on branch `publish`. Initial working tree had a modified `planning/publish.md`
  and an untracked `planning/publish-log.md`; treated them as user-authored context.
- Baseline verification passed before edits: `pnpm check` and `pnpm test`.
- Project inventory: TypeScript package with Relay client code, stdio and Streamable
  HTTP MCP server entrypoints, MCP tools for listing/reading/patching/live editing,
  attachment metadata/content support, and live integration tests skipped unless
  live Relay paths are configured.
- Code/security fixes:
  - Config files containing Relay bearer tokens are now written with owner-only
    permissions where supported.
  - Inline attachment downloads now stop reading when configured byte caps are
    exceeded even if the server omits `Content-Length`.
  - GitHub login no longer prints bearer-token shell exports unless `--print-env`
    is passed.
  - User-facing command/error text now points to `obsidian-relay-mcp`.
- Installation decisions:
  - Chose npm package publishing as the primary distribution because it gives
    OpenClaw and other MCP clients a stable `npx -y obsidian-relay-mcp` command.
  - Kept source checkout usage through `pnpm mcp:stdio` for local development.
  - Added a single package CLI with `stdio` default plus `http`, `login:github`,
    and `choose-target` subcommands.
  - Kept existing local `.relay-client.json` compatibility, but otherwise default
    to a user config file so OpenClaw does not depend on its launch directory.
- Documentation:
  - Rewrote README for public GitHub use, current tool behavior, npm/OpenClaw
    installation, configuration, TypeScript API, and security notes.
  - Updated the skill heading/link text to the published project name.
- Verification after edits so far: `pnpm check` and `pnpm test` pass.
- Packaging check:
  - `pnpm build` passes.
  - `pnpm pack --dry-run` includes the compiled package output, README, skill,
    license, and package metadata.
  - Compiled CLI help and unknown-command paths work.
- History/current-tree audit:
  - `git grep` across `publish` history found no obvious real bearer tokens or
    API keys, but did find developer-only paths, internal planning text, a draft
    commit message, and author metadata that should not be part of the public branch.
  - `git filter-repo` is not installed in this environment.
  - Chosen redaction strategy: remove internal planning/research files from the
    publish tree, keep this sanitized publish log, and replace `publish` with a
    single clean local commit. This avoids changing `master` or the remote while
    leaving no old private commits reachable from the `publish` branch.
  - Rewrote local branch `publish` to a single root commit with noreply author
    metadata. `master` and `origin/master` were left unchanged.
- Final verification on rewritten `publish`:
  - `pnpm check` passes.
  - `pnpm test` passes.
  - Current-tree scan now reports only expected false positives such as localhost
    documentation, placeholder URLs, and test-only fake values.
