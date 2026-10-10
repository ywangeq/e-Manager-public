# Local installation — public release 1.1

This checkout is an independent source snapshot with fresh publication history. It does not share a Git worktree, application identity, data directory or service port with the upstream development repository. Platform source and prebuilt packages are distributed separately from user-owned business assets.

## Run Center

Requires Node.js 24.13+ and pnpm 11. From this directory:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm local:install
pnpm start
```

Open http://127.0.0.1:14878. The account is `admin@localhost`; the installer creates a unique password in ignored `data/local/first-login.txt`. The server verifies a salted scrypt hash. The password file can be removed after reading it. Reinstalling preserves the existing account and runtime encryption keys. Protect and back up the complete data directory together; deleting encryption keys makes existing encrypted records unreadable.

The start command binds only to loopback, serves the built UI from the same origin, and excludes inherited enterprise credentials and foreign store-path settings. Cross-origin requests and non-loopback Host headers are rejected. This is a local single-user mode, not an enterprise authentication replacement. External business Tools still require their own target-system identity and authorization.

## Desktop

The Group Studio 3.x macOS arm64 package uses app identity `com.emanager.local.groupstudio`, Center `http://127.0.0.1:14878`, no insecure credential transport exception and no configured update feed. It opens the local Center login page in the existing Electron session. The installer does not start or bundle Center; start Center first. The package ZIP is generated under ignored `desktop-channel-mvp/release/`. It is not signed/notarized for public distribution. Windows installation has not been verified.

The device execution helper is retained and built; its sandbox and authorization gates are not bypassed. The empty employee selection is a UI state, not a registered employee asset.

## Resources removed from the package

- Preinstalled employees, basic/business Skills, review Workers and enterprise Tools.
- Provider routes/credentials, subsystem records, review/demo records, Trigger bindings and scheduled task publications.
- Employee/Skill prompt profiles, private asset-source defaults and known business Skill aliases.
- Employee character registry and 34 character image files; Desktop character imagery is replaced with a generic device icon.
- Company-specific business Trigger registrations that otherwise made startup depend on private task definitions and callback credentials.
- Upstream deployment configuration, `.env` files, runtime data, internal docs, reports, CI and Git history.

Generic asset import, review, lifecycle, entitlement, canonical Runtime, encrypted task/session persistence and Tool governance remain. Optional industry adapter code and inert legacy entrypoints remain; no corresponding employee, Skill or credentials are supplied. Upstream employee aliases, implicit root-Skill bindings and reviewer defaults have been removed. Empty catalogs are intentional. No employee or Skill is silently created or made runnable. Provider configuration and user-owned approved assets are still required for real model/business execution; no such execution was tested.

## Evidence and limits

Center and Desktop frontend builds passed. Six focused tests verify hashed passwords, account/key preservation, loopback binding, login/revalidation/logout, unauthorized access, cross-origin/Host rejection and empty catalogs. Browser login and the empty management view were inspected. The macOS Group Studio ZIP was built with its native helper, license and correct managed Center, and its packaged renderer was launched. An empty-catalog crash in Desktop was fixed. Full Desktop authentication/asset import/model execution, Windows, enterprise SSO and public distribution acceptance remain unverified.

The Center ZIP was extracted to another directory, independently installed from the lockfile, started on a separate loopback port and verified through real password login and an empty employee catalog. It contains required shared Desktop contract modules, not an entire Desktop application. Group Studio ignores the upstream DIGITAL_WORKFORCE_SERVER_URL environment variable and uses only its own loopback configuration and application data directory. Packages exclude installation data and credentials. An original text-summary Skill example is supplied separately; archive intake and its identity were verified, not the full review/model execution workflow.

Group delivery review requires a governed reviewer Skill; select its stable ID explicitly with `EMANAGER_REVIEWER_SKILL_ID` when starting Center. An absent selection does not invent a reviewer or make an unreviewed asset runnable. Release 1.1 uses Group Studio internal version 3.0.0-beta.69; the release number denotes this public distribution, not a Desktop 2.x build.

Skill 归档导入还需要 PATH 中有 `python3`、`unzip` 和 `tar`；Python Harness 需另行准备对应执行依赖。

Public release-to-beta mappings and immutable attachment digests are recorded in [Release versions](release-versions.md). Development updates do not automatically change an already published package.

## Model credentials

The distribution does not include a model API key or shared inference quota. Users must supply their own model service URL, model name and API key before running AI tasks. Center startup and local login do not require a model key. Configure credentials locally; never commit them or paste them into public Issues. Usage is billed by the selected model service.

## 1.1 update boundary

This release synchronizes committed platform changes only. It adds Device Read transport and authorization boundaries, durable task continuations and confirmation delivery recovery, calendar/automation views, personal task display and operations monitoring refinements. Public local authentication, empty catalogs (including empty builtin Tool migrations), loopback Center configuration, application identity, data isolation and disabled automatic updates remain authoritative. Internal employee/Skill/character data and catalog-dependent internal tests are excluded. The local calendar Runtime bundle is generated from this sanitized source rather than copied from development builds.

The Feishu read helper is built from the pinned official CLI archive and reviewed Go compiler; source, compiler, final executable digest and target architecture are verified. Packaging rechecks the sealed resources. It does not include CLI login state or credentials. For source packaging, run `pnpm --dir desktop-channel-mvp desktop:package`; official compiler/source downloads require network access. No network business read, live Feishu authorization or model execution is claimed as accepted. Local accounts are not company SSO identities; integrations which require verified company identity must be adapted under the existing authorization contracts, not bypassed.

The 1.0 release and attachments remain available. Back up the whole local data directory before upgrading; preservation of account/encryption keys is tested, while migration of populated user business/task stores and a complete GUI upgrade remain pending user acceptance.
