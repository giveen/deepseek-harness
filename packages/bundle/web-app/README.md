# `@deepseek-ai/dsh-web-app`

English | [中文](README.zh.md)

The dsh browser-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it sets the coding persona, inserts the Web host rows (webserver, API gateway, workspace, projection cache, storage) and the browser plugin roster, the always-on client-plugin reload chain ([`dsh-client-hmr`](../../client/hmr/README.md), idle until a rebuild watcher rewrites client bundles), and mounts this package's `web-runtime` glue plugin (config `{printUrl, surfaceContext, trustedHosts, lanInstanceProbeTimeoutMs}`). That plugin resolves the built frontend dist through `@deepseek-ai/dsh-web-frontend`'s exports, samples bind-dependent LAN addresses once for the URL display and Web runtime diagnostics, provides the snapshot as `webRuntime`, and mounts the [`frontend-static`](../../host/frontend-static/README.md) fallback owner; the connection plugin independently derives the same non-internal IPv4 authorities for its `/api` trust fence, registers the harness-source and web-surface prompt sections plus the bash-visible `DSH_WEB_URL` runtime variable when `surfaceContext` is true, and prints the `dsh web:` URL line when `printUrl` is true, after its Loader tree settles so a sibling failure cannot announce a dead app. The CLI takes an exclusive `$DSH_HOME/web-host.lock` before booting this profile, so a second Web process using the same session home fails before it can expose a divergent session store; stale locks from a dead process are recovered automatically. After readiness it also probes each advertised LAN authority and warns when that authority serves a different opaque Web instance identity; this catches externally launched or differently configured hosts before users mistake an empty session list for a session-sharing failure. This bundle also owns the app command line: the ordinary `web-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), parses `--host`, `--port`, repeatable `--trusted-host`, and the app's `--help`, then provides `webStartup`. It accepts `--host 0.0.0.0` for LAN serving and derives the corresponding IPv4 trust authorities after bind. Flag-configured rows inject the service and read it directly from lazy config, so nothing binds a port before argument resolution and `dsh --profile web --help` starts no server. [`dsh-headless`](../headless/README.md) is a sibling surface over the same base and does not mount this bundle.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (order −98) orients the model to the GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

The prompt section sits near the system prompt's head and is stable for the life of the process (the port is a boot fact), so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **`lanAddresses` is a boot-time snapshot** — interface changes after boot are not re-advertised; the printed LAN URL always matches the configured trust fence.
- **Session sharing requires one Web instance** — the session list is host-owned, so loopback and LAN URLs served by different processes or different `$DSH_HOME` values cannot share live agents. The CLI lock prevents two `dsh web` processes with one `$DSH_HOME`; a post-start LAN instance probe warns about externally launched or differently configured mismatches, but does not merge independent processes.
