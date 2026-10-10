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

## Unified exec output buffer

`src/head_tail_buffer.rs` and `src/head_tail_buffer_tests.rs` are source-adapted
from OpenAI Codex revision `95ec468619386ebb93506ac2091a48e5a558d25c`:

- `codex-rs/core/src/unified_exec/head_tail_buffer.rs`
- `codex-rs/core/src/unified_exec/head_tail_buffer_tests.rs`
- The omission formatter from `codex-rs/core/src/unified_exec/mod.rs`.

The head/tail algorithm and original test cases are preserved. Adaptations replace
the crate-local byte budget with the helper's 32KiB per-pipe budget, localize the
omission formatter, use standard assertions and allow unused upstream methods.
This does not embed Codex's process/session manager, stdin Tool, Provider or UI.
The existing Apache-2.0 license copy applies.

## Process-group signals

`src/process_group.rs` source-adapts only group-signalling functions from
`codex-rs/utils/pty/src/process_group.rs` at the same fixed `95ec468` revision.
The macOS PermissionDenied member fallback algorithm is unchanged.
`src/process_group_tests.rs` adapts the two scenarios in upstream
`codex-rs/utils/pty/src/process_group_tests.rs` to std::process, synchronous
deadlines and standard assertions; it does not require tokio/anyhow.
This is best-effort cleanup of the original PGID, not containment of descendants
that move into another process group/session.
