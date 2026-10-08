# Publication journal

## 2026-10-08 · GITHUB-PUBLIC-001

补充 README 与 docs/secondary-development.md：明确计划交付 Center 源码、需要 Node.js/pnpm 的命令启动 ZIP、Group Studio 3.x；区分配置、资产制作和源码适配，说明免费 Demo 与付费资产为后续计划。公开内容仅为文档，源码、安装包与现有业务资产尚未上传，1.0 发布工作继续进行。保留官方许可证原文及企业接入边界。验证：git diff --check、相对文档链接与公开树文件范围核对。未声称完整业务流程已验收；未修改原开发仓库、租约或运行状态。

补充 · GITHUB-PUBLIC-001：按用户确认的产品方向，说明个人桌面工作台后续计划集成到 Group Studio，统一个人与协作入口；未声称整合已实现。仅修改 README 与本条记录，git diff --check 通过。

补充 · GITHUB-PUBLIC-001：将 README 资产说明简化为交付范围、使用准备及后续资产包计划，移除内部出口审阅过程描述；按用户授权增加公开邮箱与微信联系方式。仅文档调整，许可及发布状态不变。验证：git diff --check，远端 README 内容回读；原开发仓库未修改。

## 2026-10-08 · GITHUB-PUBLIC-001

Implemented a local-only installation candidate in the independent checkout. Authoritative boundaries: tools/local-install.mjs and tools/start-local.mjs own installation/isolated configuration; server/auth/local-account.mjs owns local password verification; the existing authorization session and Runtime remain execution authorities. Removed preloaded business catalogs, character resources and business Trigger bootstrap registrations. Preserved import/review and per-Tool authorization, encrypted persistence and the native device helper. Center/Desktop builds and five focused local tests passed; browser Center login and packaged Group Studio 3.x renderer and local login URL verified. Packages/source stay local pending export review. No upstream checkout, GitLab config, writer lease or service was changed by this task. Do not overwrite existing local accounts, encryption keys or data when reinstalling. Retained debt: unregistered business adapter code and compatibility identifiers still require a deliberate export-boundary review. No claim of full model execution or enterprise deployment acceptance.

Corrected the desktop target from the old 2.x shell to Group Studio 3.x. Desktop initially inherited an enterprise endpoint; the local fork now ignores the upstream endpoint environment variable, restricts managed origins to loopback and uses a unique application data namespace. Existing enterprise configuration was not changed. Verified a clean extracted Center package with an independently generated account and store.

## 2026-10-08 · GITHUB-PUBLIC-001 · public 1.0 distribution

Prepared the public 1.0 source snapshot and rebuilt Center and Group Studio 3.x in this independent checkout. Removed upstream identity aliases, private asset default bindings and enterprise origins; reviewer selection now requires explicit governed configuration. Added one original text-summary Skill example, verified by the real archive intake parser. No original business employee or Skill content is shipped. Kept optional industry adapter code and inert compatibility entrypoints as documented debt; no new runtime lane or authorization bypass was introduced. Both frontend builds and six focused tests passed, including rejection of unscoped integration secret migration. The release check scans source and archives for credential signatures and compares them with known local secrets without logging values. Reinstallation preserves account and encryption keys. macOS arm64 package remains unsigned; Windows and complete model/business workflows are not accepted. Final source publication excludes the unpublished development checkpoint and retains only independent public history. Original development checkout, lease, GitLab and services were not modified.

Final release evidence: clean-extracted Center ZIP installed independently from the lockfile and passed the HTTP login/session/empty-catalog suite. Group Studio ASAR identity and 9,202 archive entries checked; source and three release archives passed known-secret/signature scans. A fake-key negative control was rejected. Release attachments contain no installation data, credentials or original employee character assets.
