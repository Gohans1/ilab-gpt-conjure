# 下载 / Releases

当前正式版本：[v0.7.2](https://github.com/kadevin/ilab-conjure/releases/tag/v0.7.2)

## 版本说明

当前版本：`v0.7.2`。本版重点升级历史库，新增收藏、标签和任务导出，统一历史库与生成页的顶部工具栏及主题体验，并新增越南语界面。建议需要整理、筛选或批量导出大量历史任务的用户更新。

本版重点：0.7.2 让历史任务可以收藏、添加多个标签并批量整理，也可以按“仅图片”或“图片＋提示词”导出；历史库同时获得与生成页一致的顶部工具栏、主题偏好和更流畅的三栏调整体验。

本版详情：

### 升级必读

- 已有任务、图片、供应商、网络设置和主题偏好都会保留。升级会自动创建独立的收藏与标签记录，不改写原任务和图片；已有任务默认处于未收藏、无标签状态。
- `v0.6.1` 及更早的 macOS 标准 App 尚未包含更新助手，需要先手动下载并覆盖安装较新版本一次；`v0.6.2` 及之后的 macOS 标准 App 可继续使用已有更新助手安装本版。
- Windows 标准 ZIP 仍需下载后手动替换；portable 包继续使用现有的用户确认式自动更新。
- `v0.5.4` 及更早 portable 用户首次升级到 `0.5.5` 或更新版本时，建议手动下载完整标准包或完整 portable 包；旧 updater 只保证升级 WebUI/依赖，不保证安装新的小兔子启动器、标准 `.app` / `.exe` 入口和迁移助手。
- 新用户建议优先下载标准包。标准包把用户数据写入系统应用数据目录；portable 包继续把数据写在同级 `data/`，用于老用户过渡、调试和临时工作流。
- macOS 一键更新只会在用户主动确认后执行，不会后台静默下载或安装；用户数据保存在应用包外，不参与程序替换。
- macOS 标准 DMG 和 portable zip 都暂未签名、未 notarize，首次启动可能需要右键或 Control-click 选择 Open。

### 收藏与标签

- 历史任务可以单独收藏，也可以同时添加多个标签；收藏是独立状态，不占用标签名称。
- 支持按收藏、单个或多个标签以及“无标签”筛选。选择多个标签时，只显示同时拥有这些标签的任务。
- 历史库侧栏可以创建、改名和删除标签；任务详情和批量工具栏都可以直接添加或移除标签，添加时也能新建标签。
- 可对最多 300 个已选任务统一收藏、取消收藏、添加标签或移除标签，失败时保留当前选择，方便修正后重试。

### 任务导出

- 单个任务或多个任务可以统一导出为一个 ZIP，多任务按任务分目录保存。
- 提供“仅图片”和“图片＋提示词”两种方式。“图片＋提示词”会为每张图片附上对应文本：优先使用该图的优化后提示词，不存在时回退到任务原提示词。
- “仅图片”不会加入提示词、任务资料、输入图、参考文件或其他本地信息。
- 单次最多导出 300 个任务；导出包在本机临时生成，通过一次性下载地址领取，完成或过期后自动清理。

### 历史库页面与语言

- 历史库顶部复用生成页的供应商、队列、任务通知、主题、GitHub 和系统设置入口；小兔子 Logo 与独立“返回生成页”入口都可以回到生成页。
- 主题切换只保留在顶部工具栏，生成页与历史库共用“跟随系统、浅色、深色”偏好。
- 收藏、标签、搜索、视图、排序和批量操作重新整理为更清楚的层级；调整三栏宽度时会合并缩略图重排，减少连续拖动时的卡顿。
- 新增越南语，界面语言增加到 14 种；页面启动期间连续切换语言时，稍后返回的旧设置不会覆盖最终选择。
- 感谢 [dpcthien](https://github.com/dpcthien) 通过 [PR #12](https://github.com/kadevin/ilab-conjure/pull/12) 贡献越南语翻译基础。

### 安装包与更新

- 继续提供 Windows x64、macOS Apple Silicon、macOS Intel 三种 portable zip，以及 macOS 双架构 DMG 和 Windows 标准 App ZIP。
- 标准包继续把用户数据保存在系统应用数据目录，portable 包保存在同级 `data/`；程序更新不会覆盖任务、图片、收藏、标签或设置。
- Release workflow 同时构建并上传 macOS Apple Silicon DMG、macOS Intel DMG、Windows 标准 App ZIP、Windows x64 portable、macOS Apple Silicon portable、macOS Intel portable、所有 `.sha256.txt` 和 signed `latest.json`。
- `latest.json` 同时服务 portable 自动更新与 macOS 标准 App 一键更新；两类更新都需要用户主动确认，并校验签名和下载文件完整性。
- 包含更新助手的 macOS 标准 App 可在用户确认后校验 DMG、带回滚保护地覆盖并重新启动；Windows 标准 ZIP 继续下载后手动替换。

## 推荐下载

| 平台 | 推荐给 | 下载 | SHA256 |
| --- | --- | --- | --- |
| macOS Apple Silicon | 新用户，M1/M2/M3/M4 | [iLab-GPT-CONJURE-macos-arm64-0.7.2.dmg](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/iLab-GPT-CONJURE-macos-arm64-0.7.2.dmg) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/iLab-GPT-CONJURE-macos-arm64-0.7.2.dmg.sha256.txt) |
| macOS Intel | 新用户，Intel x64 | [iLab-GPT-CONJURE-macos-x64-0.7.2.dmg](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/iLab-GPT-CONJURE-macos-x64-0.7.2.dmg) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/iLab-GPT-CONJURE-macos-x64-0.7.2.dmg.sha256.txt) |
| Windows x64 | 新用户，Windows 10/11 x64 | [iLab-GPT-CONJURE-windows-x64_0.7.2.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/iLab-GPT-CONJURE-windows-x64_0.7.2.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/iLab-GPT-CONJURE-windows-x64_0.7.2.zip.sha256.txt) |

标准包数据目录：

- macOS：`~/Library/Application Support/iLab GPT CONJURE/`
- Windows：`%APPDATA%\iLab GPT CONJURE\`

包含更新助手的 macOS 标准 App 会校验 signed `latest.json` 与 DMG SHA256，并在用户确认后自动覆盖、失败回滚和重新启动；`v0.6.1` 及更早的 macOS 标准 App 需要先手动安装当前版本一次，Windows 标准 ZIP 仍手动替换。

## 免安装一键包

| 平台 | 适用设备 | 下载 | SHA256 |
| --- | --- | --- | --- |
| Windows x64 | Windows 10/11 x64 | [ilab-gpt-conjure_windows_portable_x64_0.7.2.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/ilab-gpt-conjure_windows_portable_x64_0.7.2.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/ilab-gpt-conjure_windows_portable_x64_0.7.2.zip.sha256.txt) |
| macOS Apple Silicon | M1/M2/M3/M4 | [ilab-gpt-conjure_macos_portable_arm64_0.7.2.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/ilab-gpt-conjure_macos_portable_arm64_0.7.2.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/ilab-gpt-conjure_macos_portable_arm64_0.7.2.zip.sha256.txt) |
| macOS Intel | Intel x64 | [ilab-gpt-conjure_macos_portable_x64_0.7.2.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/ilab-gpt-conjure_macos_portable_x64_0.7.2.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/ilab-gpt-conjure_macos_portable_x64_0.7.2.zip.sha256.txt) |

portable 自动更新 manifest：

- [latest.json](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.2/latest.json)

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
