# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

Official Web branding plugin. It fills the generic sidebar mark, sidebar name, and blank-session hero mark slots with the DeepSeek fish and wordmark. The Web bundle includes it as a browser client row; the package does not own session or model state.

The client entry registers only when the build selected `DSH_CLIENT_BUILD_PROFILE=official`. This keeps branding a build decision: a deployment can omit the row or provide another slot occupant without changing the shared sidebar or conversation shells. The host half is intentionally empty; the browser half is loaded through the client module table.

## Model Experience

None, as this package changes browser presentation only and contributes no model-visible prompt, tool, or provider request data.

#### KV Cache effect

None; it neither assembles nor sends model requests.

## Known Limitations and Deferred Work

- The current official profile supplies the fixed `DeepSeek Harness` wordmark; deployment-specific runtime branding requires a validated runtime configuration seam rather than a browser environment read.
- The package fills only the generic brand slots. A deployment replacing the sidebar or conversation shell must provide its own brand presentation.
