# 下载 / Releases

当前正式版本：[v0.7.1](https://github.com/kadevin/ilab-conjure/releases/tag/v0.7.1)

## 版本说明

当前版本：`v0.7.1`。本版集中修复任务数据清理、历史列表可用性和瞬时网络故障，并新增显式网络出口设置。建议使用大量历史任务、多任务队列或代理网络的用户更新。

本版重点：0.7.1 让删除、排序、分页、缩略图和任务完成提醒保持一致，补齐批量取消与瞬时网络错误重试；同时增加系统、直连和自定义 HTTP(S) 代理三种明确出口，并在标准包与 portable 包中安全保存。

本版详情：

### 升级必读

- 默认网络出口仍是“系统”，升级不会自动启用代理、直连、测速或自动选路。自定义出口只接受不含账号密码的 HTTP(S) 代理 origin，不支持 SOCKS。
- 网络出口设置保存在应用数据目录；标准包和 portable 包更新程序时都不会覆盖。已经运行中的生成尝试保持其启动时的出口，保存新设置只影响随后开始的尝试。
- `v0.6.1` 及更早的 macOS 标准 App 尚未包含更新助手，需要先手动下载并覆盖安装较新版本一次；`v0.6.2` 及之后的 macOS 标准 App 可继续使用已有更新助手安装本版。
- Windows 标准 ZIP 仍需下载后手动替换；portable 包继续使用现有的用户确认式自动更新。
- `v0.5.4` 及更早 portable 用户首次升级到 `0.5.5` 或更新版本时，建议手动下载完整标准包或完整 portable 包；旧 updater 只保证升级 WebUI/依赖，不保证安装新的小兔子启动器、标准 `.app` / `.exe` 入口和迁移助手。
- 新用户建议优先下载标准包。标准包把用户数据写入系统应用数据目录；portable 包继续把数据写在同级 `data/`，用于老用户过渡、调试和临时工作流。
- 已有任务、图片和供应商设置会继续保留；只有用户明确删除任务或清理未精选/失败结果时，相关本地文件与源信息才按对应操作清理。
- macOS 一键更新只会在用户主动确认后执行，不会后台静默下载或安装；用户数据保存在应用包外，不参与程序替换。
- macOS 标准 DMG 和 portable zip 都暂未签名、未 notarize，首次启动可能需要右键或 Control-click 选择 Open。

### 任务数据与历史列表

- 删除整个任务现在会同步清理对应输出图片、缩略图和源信息文件；清理未精选图片或失败项只删除对应结果，并维护任务索引与历史库的一致性。
- 任务首次进入终态时固定原始终止时间，后续清理失败项、精选或查看只更新维护时间，不再把旧任务误排到最新位置。
- 生成页的今天、昨天和最近 7 天按组独立分页，首屏保持轻量，加载更多不会让一个大组挤掉其他日期；删除后自动重新加载并补齐当前组。
- 缩略图继续使用侧栏专用小尺寸按需加载；历史库保留完整分页入口，任务多时不再依赖一次性加载全部记录。
- 运行中与历史任务的边界更清楚；活动任务达到两项时可批量取消，任务删除使用收起动效，卡片文字不再意外被选中。
- 用户停留在较早任务且列表已滚动时，新完成任务会累计到“回到最新”按钮；点击后回到最新组顶部，避免漏看刚完成的结果。

### 生成与网络稳定性

- `502` 且类型为 `upstream_error` 现在会作为瞬时上游故障自动重试；SSL EOF、连接重置和远端断开等明确瞬时网络错误也进入同一有限重试策略。
- 修复提示词末尾输入 `~`、`～` 等片段触发符时可能卡住页面的问题。感谢 [RobinZhiBin](https://github.com/RobinZhiBin) 通过 [PR #10](https://github.com/kadevin/ilab-conjure/pull/10) 贡献修复。
- 系统设置新增独立“网络”Tab，可明确选择系统环境代理、完全直连或自定义 HTTP(S) 代理；该选择不改变供应商、模型和协议配置。
- 自定义代理拒绝凭据、路径、查询参数和 SOCKS 地址。连接检测只在用户点击时运行，目标固定为当前 Codex/API 供应商 origin，且不发送 API Key。
- 每次生成尝试开始时冻结网络出口，同一尝试内的请求与重试保持一致；修改设置只影响后续尝试，任务元数据只记录模式和实际路由类型，不记录代理地址。

### 安装包与发布工作流

- 继续提供 Windows x64、macOS Apple Silicon、macOS Intel 三种 portable zip，以及 macOS 双架构 DMG 和 Windows 标准 App ZIP。
- 标准包将网络出口配置保存在系统应用数据目录，portable 包保存在同级 `data/`；程序更新不会预填或覆盖代理设置。
- Release workflow 同时构建并上传 macOS Apple Silicon DMG、macOS Intel DMG、Windows 标准 App ZIP、Windows x64 portable、macOS Apple Silicon portable、macOS Intel portable、所有 `.sha256.txt` 和 signed `latest.json`。
- `latest.json` 同时服务 portable 自动更新与 macOS 标准 App 一键更新；两类更新都需要用户主动确认，并校验签名和下载文件完整性。
- 包含更新助手的 macOS 标准 App 可在用户确认后校验 DMG、带回滚保护地覆盖并重新启动；Windows 标准 ZIP 继续下载后手动替换。

## 推荐下载

| 平台 | 推荐给 | 下载 | SHA256 |
| --- | --- | --- | --- |
| macOS Apple Silicon | 新用户，M1/M2/M3/M4 | [iLab-GPT-CONJURE-macos-arm64-0.7.1.dmg](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/iLab-GPT-CONJURE-macos-arm64-0.7.1.dmg) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/iLab-GPT-CONJURE-macos-arm64-0.7.1.dmg.sha256.txt) |
| macOS Intel | 新用户，Intel x64 | [iLab-GPT-CONJURE-macos-x64-0.7.1.dmg](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/iLab-GPT-CONJURE-macos-x64-0.7.1.dmg) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/iLab-GPT-CONJURE-macos-x64-0.7.1.dmg.sha256.txt) |
| Windows x64 | 新用户，Windows 10/11 x64 | [iLab-GPT-CONJURE-windows-x64_0.7.1.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/iLab-GPT-CONJURE-windows-x64_0.7.1.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/iLab-GPT-CONJURE-windows-x64_0.7.1.zip.sha256.txt) |

标准包数据目录：

- macOS：`~/Library/Application Support/iLab GPT CONJURE/`
- Windows：`%APPDATA%\iLab GPT CONJURE\`

包含更新助手的 macOS 标准 App 会校验 signed `latest.json` 与 DMG SHA256，并在用户确认后自动覆盖、失败回滚和重新启动；`v0.6.1` 及更早的 macOS 标准 App 需要先手动安装当前版本一次，Windows 标准 ZIP 仍手动替换。

## 免安装一键包

| 平台 | 适用设备 | 下载 | SHA256 |
| --- | --- | --- | --- |
| Windows x64 | Windows 10/11 x64 | [ilab-gpt-conjure_windows_portable_x64_0.7.1.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/ilab-gpt-conjure_windows_portable_x64_0.7.1.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/ilab-gpt-conjure_windows_portable_x64_0.7.1.zip.sha256.txt) |
| macOS Apple Silicon | M1/M2/M3/M4 | [ilab-gpt-conjure_macos_portable_arm64_0.7.1.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/ilab-gpt-conjure_macos_portable_arm64_0.7.1.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/ilab-gpt-conjure_macos_portable_arm64_0.7.1.zip.sha256.txt) |
| macOS Intel | Intel x64 | [ilab-gpt-conjure_macos_portable_x64_0.7.1.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/ilab-gpt-conjure_macos_portable_x64_0.7.1.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/ilab-gpt-conjure_macos_portable_x64_0.7.1.zip.sha256.txt) |

portable 自动更新 manifest：

- [latest.json](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.1/latest.json)

使用方式：

1. 下载对应平台的 zip。
2. 解压到普通用户目录，不要放在系统保护目录。
3. Windows 双击 `Start iLab GPT CONJURE.exe`；macOS 双击
   `Start iLab GPT CONJURE.app`。旧的 `Start WebUI Portable.bat` /
   `Start WebUI Portable.command` 仍保留，用于终端调试。
4. 如果浏览器没有自动打开，访问 `http://127.0.0.1:8787/`。

一键包启动器不会后台自动访问 GitHub。更新已经解压的一键包时，可在托盘 / 菜单栏
菜单选择检查更新，并在发现新版本后确认 `安装更新`；也可以退出启动器后手动运行
Windows 的 `Update WebUI Portable.bat` 或 macOS 的 `Update WebUI Portable.command`。
更新脚本会读取带签名的 `latest.json`
manifest，先用启动器内置公钥校验 Ed25519 签名，再下载当前平台对应的最新
GitHub Release 资产，执行前显示所选资产和 manifest SHA256，校验下载 zip 的
SHA256，只替换一键包目录内由程序管理的文件，保留本地 `data/`，并把被替换文件备份到 `.backup/`。

macOS 标准 DMG 和 portable zip 都暂未签名、未 notarize。如果 macOS
拦截启动，可以右键或 Control-click App，选择 Open，并在系统安全提示中再次确认。
portable zip 也可以对解压目录执行：

```bash
xattr -dr com.apple.quarantine /path/to/ilab-gpt-conjure_macos_portable_arm64
# 或：
xattr -dr com.apple.quarantine /path/to/ilab-gpt-conjure_macos_portable_x64
```

一键包内的 `data/` 目录会保存本地设置、公用图库、输入图、输出图、任务数据库和日志。
不要把这些本地数据、API key 或 OAuth 文件提交到 Git。
