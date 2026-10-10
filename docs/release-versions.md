# 发行版本对应表

公开发行号与 Group Studio 内部开发版本分别记录。开发分支持续更新，不代表已发布的安装包同步更新；以该次 Release 的文件及校验值为准。

| 公开发行 | Group Studio 内部版本 | 发布日期 | 对应源码快照 |
| --- | --- | --- | --- |
| [1.1 / v1.1.0](https://github.com/ywangeq/e-Manager-public/releases/tag/v1.1.0) | `3.0.0-beta.69` | 2026-10-10 | 独立公开标签 `v1.1.0`（不包含上游开发历史） |
| [1.0 / v1.0.0](https://github.com/ywangeq/e-Manager-public/releases/tag/v1.0.0) | `3.0.0-beta.32` | 2026-10-08 | `35de34b3a704f9cb4efbff691425450fb6ad471c` |

以上为独立公开发行快照，不跟随 GitLab 开发分支自动更新。2026-10-08 的隐私修订保留桌面版本 `3.0.0-beta.32`，更新了公开署名、源码历史及发行附件；以下校验值对应修订后的当前附件。

## 1.0 文件校验值

| 文件 | SHA-256 |
| --- | --- |
| `e-manager-center-1.0.0.zip` | `e82e4d2258764cde072df48641bab5eeb5d4d6a5064206534eecfe2077020c61` |
| `e-manager-group-studio-3-1.0.0-macos-arm64.zip` | `e214bb3694a99922d2b80567eb85473d5b526a6e204a604e1d581d736891e04b` |
| `e-manager-example-text-summary-1.0.0.zip` | `f25aa4987947ef75222c22de5d2cdf77ef119a05adde1ed0f03b0c6fbe9359d3` |

版本来自源码 `desktop-channel-mvp/package.json` 与已发布桌面包内 `app.asar/package.json` 的核对。后续发行需同时记录公开发行号、内部 beta 版本、源码快照和附件校验值；不要仅凭“1.0”判断桌面开发版本。

## 1.1 文件校验值

以下与 Release 附件 `SHA256SUMS` 对应；源码以公开标签 `v1.1.0` 为准。

| 文件 | SHA-256 |
| --- | --- |
| `e-manager-center-1.1.0.zip` | `01773afd3c54f9f566a0d031738ea86a27e7063e912034e1a72c50ba8a3bd96a` |
| `e-manager-example-text-summary-1.1.0.zip` | `f25aa4987947ef75222c22de5d2cdf77ef119a05adde1ed0f03b0c6fbe9359d3` |
| `e-manager-group-studio-3-1.1.0-macos-arm64.zip` | `168590a6f472674964ab19d9e45435aca49407156be2c448be487f168d46b138` |
