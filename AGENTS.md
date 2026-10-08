# Independent local distribution

- This checkout owns the local distribution only. Never write to or operate the upstream development checkout, its Git remotes, data, leases or services.
- Do not import development history, deployment state, credentials, business employees, Skills, prompts or character assets.
- Preserve the canonical Runtime, session authorization, Tool governance, import review and lifecycle boundaries.
- Local authentication is for a loopback-bound single-user installation. It does not grant authority in external business systems.
- Keep local data and generated packages ignored. Do not push source or binaries until the export and asset review has passed.
- Verify local authentication, empty catalogs, isolated state and pnpm build; record scope and remaining limitations in docs/current-state.md.
