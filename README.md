# DeepSeek Harness Desktop

Electron desktop host for the DeepSeek Harness Web UI. The Electron main
process starts `dsh web` with Electron's bundled Node runtime on an OS-assigned
loopback port and loads that URL in an isolated `BrowserWindow`.

Application identity:

- app ID: `com.harness.deepseek-harness-desktop`
- product: `DeepSeek Harness Desktop`
- initial version: `0.0.1`

## Development

```bash
npm install
npm start
```

The default Harness workspace is the current user's Documents directory. To
select another initial directory:

```bash
npm start -- --workspace /absolute/path/to/workspace
```

You can also set `DSH_WORKSPACE`. The Web UI still requires the workspace to be
added and selected before the first task is sent.

Harness settings, sessions, and credentials are stored under Electron's
`userData/dsh` directory rather than the default `~/.dsh`.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Create an unpacked application directory with `npm run pack`. ASAR is disabled
for the initial integration so the Harness runtime and platform dependencies
remain directly accessible. Enable ASAR only after validating explicit unpack
rules on every supported platform. Local verification builds may be unsigned;
tagged GitHub releases require signing credentials and macOS notarization.

## Cross-platform builds

GitHub Actions packages macOS arm64, macOS x64, and Windows x64 on native
runners. Pull request builds are unsigned verification artifacts. Version tags
run the signed release workflow and fail when the required certificate secrets
are not configured.

See [the release guide](docs/RELEASING.md) for the required Apple and Windows
signing secrets and the `v0.0.1` release procedure.
