# 发行版本对应表

公开发行号与 Group Studio 内部开发版本分别记录。开发分支持续更新，不代表已发布的安装包同步更新；以该次 Release 的文件及校验值为准。

| 公开发行 | Group Studio 内部版本 | 发布日期 | 对应源码快照 |
| --- | --- | --- | --- |
| [1.0 / v1.0.0](https://github.com/ywangeq/e-Manager-public/releases/tag/v1.0.0) | `3.0.0-beta.32` | 2026-10-08 | `v1.0.0` 标签对应的隐私修订快照 |

以上为独立公开发行快照，不跟随 GitLab 开发分支自动更新。2026-10-08 的隐私修订保留桌面版本 `3.0.0-beta.32`，更新了公开署名、源码历史及发行附件；以下校验值对应修订后的当前附件。

## 1.0 文件校验值

| 文件 | SHA-256 |
| --- | --- |
| `e-manager-center-1.0.0.zip` | `c5fdb34f431ef87c0bc8744364d4901604818e9f0506bd58aa5f2a6af0c6d741` |
| `e-manager-group-studio-3-1.0.0-macos-arm64.zip` | `e214bb3694a99922d2b80567eb85473d5b526a6e204a604e1d581d736891e04b` |
| `e-manager-example-text-summary-1.0.0.zip` | `f25aa4987947ef75222c22de5d2cdf77ef119a05adde1ed0f03b0c6fbe9359d3` |

版本来自源码 `desktop-channel-mvp/package.json` 与已发布桌面包内 `app.asar/package.json` 的核对。后续发行需同时记录公开发行号、内部 beta 版本、源码快照和附件校验值；不要仅凭“1.0”判断桌面开发版本。
