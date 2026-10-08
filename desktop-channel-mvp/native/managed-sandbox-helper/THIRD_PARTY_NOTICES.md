# Third-party notices

This helper contains a deliberately small, source-adapted Seatbelt policy
generator based on the Apache-2.0 licensed OpenAI Codex repository at revision
`83d1fe0e67b1323f71febc2925817732b449f1d9`:

- `codex-rs/sandboxing/src/seatbelt.rs`
- `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`
- `codex-rs/sandboxing/src/restricted_read_only_platform_defaults.sbpl`

The adapted source is in `src/seatbelt_policy.rs`. It intentionally does not
include Codex protocol types, network proxying, provider/session code, CLI,
app server, model runtime, task store, authorization system, or UI. The helper
is linked only with `libc`, `serde`, and `serde_json` from crates.io; none are
used for remote access.

The helper does not embed or invoke the Codex CLI, app server, model runtime,
task store, authorization system, or UI.
