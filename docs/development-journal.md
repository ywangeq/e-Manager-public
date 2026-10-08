# Publication journal

## 2026-10-08 · GITHUB-PUBLIC-001

补充 README 与 docs/secondary-development.md：明确计划交付 Center 源码、需要 Node.js/pnpm 的命令启动 ZIP、Group Studio 3.x；区分配置、资产制作和源码适配，说明免费 Demo 与付费资产为后续计划。公开内容仅为文档，源码、安装包与现有业务资产尚未上传，1.0 发布工作继续进行。保留官方许可证原文及企业接入边界。验证：git diff --check、相对文档链接与公开树文件范围核对。未声称完整业务流程已验收；未修改原开发仓库、租约或运行状态。

补充 · GITHUB-PUBLIC-001：按用户确认的产品方向，说明个人桌面工作台后续计划集成到 Group Studio，统一个人与协作入口；未声称整合已实现。仅修改 README 与本条记录，git diff --check 通过。

补充 · GITHUB-PUBLIC-001：将 README 资产说明简化为交付范围、使用准备及后续资产包计划，移除内部出口审阅过程描述；按用户授权增加公开联系方式。仅文档调整，许可及发布状态不变。验证：git diff --check，远端 README 内容回读；原开发仓库未修改。

## 2026-10-08 · GITHUB-PUBLIC-001

Implemented a local-only installation candidate in the independent checkout. Authoritative boundaries: tools/local-install.mjs and tools/start-local.mjs own installation/isolated configuration; server/auth/local-account.mjs owns local password verification; the existing authorization session and Runtime remain execution authorities. Removed preloaded business catalogs, character resources and business Trigger bootstrap registrations. Preserved import/review and per-Tool authorization, encrypted persistence and the native device helper. Center/Desktop builds and five focused local tests passed; browser Center login and packaged Group Studio 3.x renderer and local login URL verified. Packages/source stay local pending export review. No upstream checkout, GitLab config, writer lease or service was changed by this task. Do not overwrite existing local accounts, encryption keys or data when reinstalling. Retained debt: unregistered business adapter code and compatibility identifiers still require a deliberate export-boundary review. No claim of full model execution or enterprise deployment acceptance.

Corrected the desktop target from the old 2.x shell to Group Studio 3.x. Desktop initially inherited an enterprise endpoint; the local fork now ignores the upstream endpoint environment variable, restricts managed origins to loopback and uses a unique application data namespace. Existing enterprise configuration was not changed. Verified a clean extracted Center package with an independently generated account and store.

## 2026-10-08 · GITHUB-PUBLIC-001 · public 1.0 distribution

Prepared the public 1.0 source snapshot and rebuilt Center and Group Studio 3.x in this independent checkout. Removed upstream identity aliases, private asset default bindings and enterprise origins; reviewer selection now requires explicit governed configuration. Added one original text-summary Skill example, verified by the real archive intake parser. No original business employee or Skill content is shipped. Kept optional industry adapter code and inert compatibility entrypoints as documented debt; no new runtime lane or authorization bypass was introduced. Both frontend builds and six focused tests passed, including rejection of unscoped integration secret migration. The release check scans source and archives for credential signatures and compares them with known local secrets without logging values. Reinstallation preserves account and encryption keys. macOS arm64 package remains unsigned; Windows and complete model/business workflows are not accepted. Final source publication excludes the unpublished development checkpoint and retains only independent public history. Original development checkout, lease, GitLab and services were not modified.

Final release evidence: clean-extracted Center ZIP installed independently from the lockfile and passed the HTTP login/session/empty-catalog suite. Group Studio ASAR identity and 9,202 archive entries checked; source and three release archives passed known-secret/signature scans. A fake-key negative control was rejected. Release attachments contain no installation data, credentials or original employee character assets.

## 2026-10-08 · GITHUB-PUBLIC-001 · module value and asset direction

Expanded README with module responsibilities and enterprise benefits, subsystem interaction diagram, and the observed-event boundary for usage/performance/incident monitoring. Clarified that diagnostic execution requires configured governed assets and authorization. Recorded the user’s future asset direction: platform-level review, operations and SOP-based employee drafting first, then department-level employees; no delivery date, automatic publishing or self-repair claim. Documentation only; existing software, release tag, licenses and API contracts are unchanged. Verification: source capability audit, relative links, Mermaid structure, git diff --check and credential scan. No upstream development checkout, lease or runtime changes.

## 2026-10-08 · GITHUB-PUBLIC-001 · architecture and r8 demonstration

Added a maintainable Mermaid logical architecture to README: authenticated/idempotent ingress, governed employee/Skill configuration, shared Runtime/Tool Loop, Provider and Tool adapters, external subsystem RBAC, Desktop Device Tool boundary, and safe operations projections. Read-only source audit preserved the distinction between ingress admission and per-Tool authorization; personal workbench integration remains a future plan. Replaced the prior 3:26 r6 demonstration with the 4:08 r8 GitHub video attachment, including 42 seconds of synthetic operations monitoring. Original and compressed video decoding passed; sampled monitoring frames explicitly identify synthetic data. Documentation/video only: software attachments, v1.0.0 tag, license and runtime contracts remain unchanged. No API keys, business assets or development history are included; original GitLab checkout, writer lease and services were not modified. Verification: git diff --check, publication credential scan, relative links, and final anonymous GitHub rendering/playback check. User acceptance remains pending.

## 2026-10-08 · GITHUB-PUBLIC-001 · public identity privacy

Removed the personal name from README, copyright notice, desktop author metadata and the example user placeholder; retained only the user-authorized Gmail and public GitHub account. Rebuilt Center and Group Studio distribution with the public account attribution; license terms are unchanged. User explicitly authorized a fresh public history and refreshed 1.0 tag to remove earlier personal-name revisions. The original GitLab checkout, leases, services and credentials remain outside this operation. Verification includes builds, name/known-secret scans of source and release ZIPs, published branch/tag checks and attachment digests. Previously cached commit/PR pages may require GitHub support to remove; do not claim those caches are erased.

## 2026-10-08 · GITHUB-PUBLIC-001 · release-to-beta mapping

Recorded public release 1.0 / v1.0.0 as Group Studio 3.0.0-beta.32, verified against source and packaged ASAR metadata. docs/release-versions.md owns the public mapping, source snapshot and current attachment SHA-256 values; README, local installation docs and Release notes link to it. Development updates do not imply package updates. Documentation only; existing tag, binaries, license and runtime unchanged. Verification: link/metadata/hash consistency, diff whitespace and publication privacy scan. Original GitLab checkout, leases and services unchanged.

## 2026-10-08 · GITHUB-PUBLIC-001 · personal contact removal

Removed the personal messaging contact from public README, Release notes and Center ZIP. Email and public GitHub contact remain; copyright attribution and official license unchanged. Recreated the public snapshot/tag under the previously authorized privacy-cleanup scope, preserving development history only in local private backups. Group Studio remains 3.0.0-beta.32; Desktop software is unchanged. Verified tracked source/archive contact scans, credentials scan, Release text readback and attachment digests. Legacy GitHub PR/cache copies remain a platform limitation. Original GitLab checkout, lease and services unchanged.

## 2026-10-08 · GITHUB-PUBLIC-001 · model key requirement and re-audit

Clarified in README, local installation docs and Release notes that model API keys and usage quota are user-supplied; starting Center/login alone does not require a key. Audited current public branch/tag, reachable legacy PR revisions and Release source/package artifacts using credential signatures and private known-secret comparison without outputting values. Documentation only, no supplied keys or runtime/permission changes. Original GitLab checkout, leases and services unchanged. Record final scan counts and any limitations in the private audit receipt; scanning does not certify unknown credentials beyond detectable signatures/known-secret matches.
