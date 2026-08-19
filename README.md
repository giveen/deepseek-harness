# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source coding-agent runtime and Web workspace from [DeepSeek AI](https://deepseek.com). It combines model providers, tools, durable sessions, permissions, workspaces, and user interfaces in one configurable application.

Everything is a plugin. [Cordis](https://github.com/cordiverse/cordis) supplies the composition model: plugins contribute services, events, tools, prompt sections, storage, and reversible effects to one runtime. You can use the shipped profiles, replace providers, add tools, or compose a smaller application from the same packages.

## Developer preview

DeepSeek Harness is in active developer preview. Features, configuration, and on-disk formats can change between releases. Report failures, confusing behavior, and setup friction through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).

## What it provides

| Surface | Use it for |
|---|---|
| **Web workspace** | Run coding sessions in a browser, choose a workspace, attach images, review the conversation, inspect workspace files, browse Git commit history, and manage provider and application settings. |
| **Agent tools** | Read and edit files, search a workspace, run Bash or PowerShell, use persistent terminals, ask for approval, create plans, schedule work, delegate to subagents, and run bounded workflows. |
| **Web access** | Search and fetch the Web, or use the managed Camofox browser tools for navigation, accessibility snapshots, clicks, typing, and scrolling. Successful browser actions can display a bounded screenshot in the chat. |
| **Models** | Use the native DeepSeek adapter, installed provider catalogs, or custom OpenAI-compatible and other supported endpoints. Model input capabilities, including image input, are declared per model. |
| **Sessions** | Keep an authoritative event log for replay, durable titles, search, exports, telemetry, forks, archiving, and recovery. SQLite-backed query and storage providers add bounded reads, full-text search, integrity checks, online backups, and mark-and-sweep retention. |
| **Automation** | Run one-shot headless tasks, expose agents through ACP or JSON-RPC, or call the bundled Python SDK from another program. |
| **Extensions** | Add Cordis plugins and profile bundles without patching the agent loop. The package and [capability-seam documentation](docs/capability-seams.md) describe the supported extension points. |

## Run

### Use the published CLI

Install Node.js 22.19+ or 24+, then run the Web profile with `npx`:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI and prints its URL. The default address is `http://127.0.0.1:3080`. The Web profile initializes its own profile directory on first use and stores machine-local settings, credentials, profiles, and session data under the active Harness home.

### Run from source

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
corepack enable
pnpm install
pnpm run build:official
pnpm dsh web
```

`pnpm run build:official` is the reproducible official-profile build for a fresh checkout and whenever the built packages or frontend need updating. `pnpm run build` preserves explicitly supplied `DSH_CLIENT_*` values for custom client artifacts. A complete build records the selected public client environment and a digest of the generated Web and dynamic client artifacts; release packing rejects missing or stale records. Source execution uses the checkout's TypeScript entry point; the installed CLI uses the published build artifacts. The invoking directory is the default workspace root.

### Configure a model

Open **Settings → Models** in the Web UI and save a provider credential. The shipped configuration supports the DeepSeek provider, catalog providers such as OpenAI and Anthropic, and custom providers for self-hosted or OpenAI-compatible gateways. A custom provider needs a base URL, protocol, credential, and at least one model.

For unattended runs, place credentials in the environment or a gitignored root `.env`:

```sh
DEEPSEEK_API_KEY=sk-your-key
DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
```

The [model configuration guide](docs/user/guide/providers.md) covers provider catalogs, custom routes, model selection, image input declarations, and provider-specific authentication. Never commit credentials.

### Choose a workspace and start a session

1. Open the Web UI and choose **Settings → Models**.
2. Add or select the directory that contains the project you want the agent to use.
3. Create a session, choose its model and permission preset, then send a task.
4. Use **Files** to inspect the workspace tree or **Commits** to browse expandable Git commit messages.
5. Attach an image when the selected model declares image input; the image and your prompt are rendered in the conversation and retained as durable session content.

The default `workspace-write` permission preset allows workspace and temporary-directory mutations while approval and sandbox plugins guard consequential operations. Review the [Web UI guide](docs/user/guide/index.md) and [CLI reference](apps/cli/reference/README.md) for the complete runtime contract.

### Serve the Web UI on a LAN

To make the Web UI reachable from another device on a trusted network:

```sh
dsh web --host 0.0.0.0 --port 3080
```

Use `--trusted-host <authority>` for a named host or port that the browser should accept:

```sh
dsh web --host 0.0.0.0 --port 3080 --trusted-host workstation.example.test
```

Loopback and the machine's advertised LAN addresses are accepted by the shipped composition. One Web process owns the live session store, so loopback and LAN URLs served by that same process see the same sessions. Starting a second Web process with another Harness home does not merge its sessions; the Web launcher uses a home lock and warns about mismatched advertised instances.

The HTTP surface has no built-in user authentication or TLS. Bind to `127.0.0.1` for local use, or place a LAN deployment behind a trusted network and an authenticated TLS reverse proxy. Do not expose an unauthenticated `0.0.0.0` listener to the public Internet.

## Browser automation with Camofox

The Web profile includes `@deepseek-ai/dsh-tool-camofox`. During installation, its required `@askjo/camofox-browser` dependency downloads the Camoufox browser binary, which is about 300 MB on the first install. Existing compatible browser caches are reused; version changes refresh the cache idempotently, and a failed refresh preserves the previous cache with a warning.

When the Web profile starts, dsh owns a loopback Camofox server at `http://127.0.0.1:9377`, waits for its `/health` endpoint, and stops it with the dsh process. The browser tools are `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, and `browser_scroll`. Take a fresh snapshot before using element refs and after navigation, page-changing actions, or scrolling. The Web client shows the latest successful bounded screenshot inside the corresponding tool row; the screenshot is presentation metadata and is not added to the model context.

If your environment supplies a compatible Camoufox executable, you can skip the binary download:

```sh
CAMOFOX_SKIP_DOWNLOAD=1
CAMOUFOX_EXECUTABLE=/absolute/path/to/camoufox
```

Camofox is loopback-only by default and has no access-key authentication. Do not expose port `9377` beyond the local host. See the [Camofox package README](packages/web/camofox/README.md) for configuration, limitations, and tool semantics.

## Other entry modes

| Command | Purpose |
|---|---|
| `dsh web` | Start the browser-based Web workspace. |
| `dsh --profile headless "run the tests"` | Create one fresh persisted session, print the final assistant response, and exit. |
| `dsh --profile <name>` | Boot a named profile under `$DSH_HOME/profiles/<name>`. |
| `dsh plugin --profile <name> add <package>` | Install a plugin into a profile and activate any declared bundle layer. |
| `pnpm run demo:acp` | Start the checked-in ACP automation example. |
| `python examples/jsonrpc-agent/minimal.py ...` | Run the Python SDK example against the bundled JSON-RPC runtime. |

Launcher flags come before profile-specific arguments. Use `dsh --profile web --help` or `dsh web --help` for Web flags, and `dsh --help` for launcher help. Use `--dump-default-config` or `--dump-config` to inspect a profile without booting it.

The [headless example](examples/headless-agent/README.md), [ACP example](examples/acp-agent/README.md), [Python SDK tutorial](docs/user/guide/python-sdk.md), and [CLI reference](apps/cli/reference/README.md) provide runnable details for each surface.

## Data, privacy, and recovery

Sessions are derived from an append-only event log. The log is the source for model history, UI replay, forks, exports, titles, and query projections; anything sent to a model is reconstructable from durable session events. The Web profile uses JSONL persistence for session artifacts and an in-memory SQLite query index by default. Other compositions can select SQLite persistence and storage backends for durable relational indexes, integrity diagnostics, online backups, pagination, and bounded mark-and-sweep deletion.

Provider credentials are stored as credential references rather than returned values. The local credential provider keeps its document under the Harness home and does not materialize resolved credentials into the model's environment. Tools still run as the local user, so filesystem permissions and the active sandbox policy remain important. Enable telemetry only when the deployment accepts the data it can contain; explicitly enabled telemetry can include message text, tool arguments and results, and workspace paths.

The [persistence subsystem reference](docs/subsystems/persistence.md), [storage subsystem reference](docs/subsystems/storage.md), [testing policy](docs/testing.md), and [CLI behavior reference](apps/cli/reference/README.md) own the detailed format, lifecycle, security, and recovery contracts.

## Architecture and customization

Read the [architecture guide](docs/architecture.md) before changing `packages/`. It explains profiles, bundles, the session and agent loop, event domains, capability seams, and the rule that new behavior belongs on documented plugin extension points.

The most useful customization paths are:

- Add a model adapter through the [LLM adapter guide](docs/cookbook/adding-an-llm-adapter.md).
- Add a model-facing tool through the [tool guide](docs/cookbook/adding-a-tool.md).
- Add a browser conversation surface through the [conversation-node guide](docs/cookbook/adding-a-conversation-node.md).
- Add a package by following the [package guide](docs/cookbook/adding-a-package.md).
- Patch a profile with `cordis.patch.yml`; inspect all configuration fields in the generated [configuration catalog](docs/config-catalog.md).
- Browse the package families in [packages/README.md](packages/README.md) and the generated [module graph](docs/module-graph.md).

A capability is complete when its Service Definition, Provider, and Consumer roles are designed together. Extension plugins depend on definitions rather than concrete providers, so local and remote implementations can be exchanged by composition.

## Development and verification

Prerequisites and the source-build layout are in the [development guide](docs/development.md). Common repository commands are:

```sh
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run doc-sync
pnpm run build:official
```

Run the smallest checks that cover your change. `pnpm run doc-sync` verifies Markdown links and wrapping, bilingual pairing, generated catalogs, source-equivalent type blocks, and documentation budgets. `pnpm run check:all` runs the comprehensive local gate set. Real-API tests use `DEEPSEEK_API_KEY` when available and self-skip without it; never commit a key or a generated secret-bearing artifact.

## Community and support

- Ask questions and report bugs in [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Browse or publish plugins with the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic.
- Join the [DeepSeek Harness Discord community](https://discord.gg/Ycq5dCaS4).
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes; the project is still in an early development stage and external pull requests may not be accepted for every area.

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
