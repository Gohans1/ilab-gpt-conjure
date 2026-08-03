# 下载 / Releases

当前正式版本：[v0.8.0](https://github.com/kadevin/ilab-conjure/releases/tag/v0.8.0)

## 版本说明

当前版本：`v0.8.0`。本版把历史库升级为可备份、恢复和高效批量整理的本地工作空间，并统一任务卡、参考图和大图查看交互，同时提供更轻的一键包。适合历史任务较多、经常使用参考图迭代，或需要迁移本地任务记录的用户更新。

本版重点：新增历史任务原始数据备份与恢复、按传统桌面文件管理选择方式操作任务并提供上下文操作、任务卡滑动与批量交互、参考图暂存、统一大图查看、API 供应商拖拽排序和可取消网络请求；升级不会迁移、重置或删除已有设置、任务数据库、历史图库、输入图和输出图。

本版详情：

### 历史任务备份与恢复

- 可在历史库后台打包任务原始记录及关联文件，打包完成后通过一次性下载取回备份，不必阻塞当前浏览和整理操作。
- 支持把备份 ZIP 分块上传并先行预检，再恢复到当前本地数据目录；已存在且内容一致的任务会跳过，标识相同但内容冲突的任务会明确拒绝。
- 导入过程包含路径、格式和资源限制检查；失败时回滚本次写入，不改动原备份，也不覆盖已有任务。
- 导入完成后会重建必要索引；重新启动程序后，恢复的任务仍可在历史库中正常搜索、筛选和打开。

### 历史库选择、定位与批量整理

- 按传统桌面文件管理选择方式操作任务：支持单击、追加选择、范围选择、键盘快捷键和空白处清除，网格与列表视图保持一致。
- 选中任务后显示与当前状态匹配的上下文操作面板，批量收藏、标签、导出和删除等操作更集中；隐藏或失效的选择不会继续参与操作。
- 当前筛选条件以可移除标签呈现，移动端提供独立筛选入口；网格密度和任务卡布局会随可用空间调整。
- 浏览位置改为按任务锚点记忆。切换筛选、排序、视图、打开详情或刷新后，会尽量回到原任务；目标不在首批结果时也能由服务端加载对应窗口。

### 任务卡、参考图与提示词

- 等待中、运行中和历史任务卡支持触控或鼠标滑动操作，并补充批量选择和键盘交互，常用任务操作不必反复打开菜单。
- 任务卡的选中、焦点、状态和操作层级重新整理；浅色／深色主题、窄屏和减少动态效果设置下均提供更清晰反馈。
- 生成页新增参考图暂存：切换任务或浏览历史时，尚未提交的参考图和输入状态可恢复，减少多轮迭代时重复选图。
- 提示词片段可在当前光标位置展开并继续组合，快捷 chip 与编辑器内容保持同步。

### 统一大图查看

- 生成页与历史库共用统一大图查看控制，支持缩放、拖动、重置、上一张／下一张和键盘导航。
- 按钮状态、焦点管理和无障碍标签统一，触控、鼠标和键盘操作得到一致反馈。

### API 供应商与任务取消

- API 供应商卡片支持拖拽排序，顺序保存在本机；连接检查会针对当前选中的供应商执行，减少误测其他配置。
- 网络执行层改为可取消的异步请求。用户取消任务或关闭程序时，取消信号可以传递到仍在等待的请求，减少不必要的等待。

### 更轻的一键包

- portable 和标准包构建会移除仅用于开发或重建的 TypeScript/CSS 源、source map、前端构建元数据、测试目录和 Python 打包工具，保留运行所需源码、已编译 WebUI 与依赖。
- README 截图改用 WebP，进一步降低仓库和下载体积；一键包的启动、更新、备份目录和本地 `data/` 保留方式不变。

### 安装与升级

- 升级前应先退出旧实例；如果提示数据目录正在使用，只需关闭旧程序后重试。
- 已有设置、任务数据库、历史图库、输入图和输出图全部保留，不需要重置配置或手动迁移。
- `v0.5.4` 及更早 portable 用户首次升级到当前版本时，建议手动下载完整标准包或完整 portable 包；旧 updater 只保证升级 WebUI/依赖，不保证安装新的小兔子启动器、标准 `.app` / `.exe` 入口和迁移助手。

## 推荐下载

| 平台 | 推荐给 | 下载 | SHA256 |
| --- | --- | --- | --- |
| macOS Apple Silicon | 新用户，M1/M2/M3/M4 | [iLab-GPT-CONJURE-macos-arm64-0.8.0.dmg](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/iLab-GPT-CONJURE-macos-arm64-0.8.0.dmg) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/iLab-GPT-CONJURE-macos-arm64-0.8.0.dmg.sha256.txt) |
| macOS Intel | 新用户，Intel x64 | [iLab-GPT-CONJURE-macos-x64-0.8.0.dmg](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/iLab-GPT-CONJURE-macos-x64-0.8.0.dmg) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/iLab-GPT-CONJURE-macos-x64-0.8.0.dmg.sha256.txt) |
| Windows x64 | 新用户，Windows 10/11 x64 | [iLab-GPT-CONJURE-windows-x64_0.8.0.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/iLab-GPT-CONJURE-windows-x64_0.8.0.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/iLab-GPT-CONJURE-windows-x64_0.8.0.zip.sha256.txt) |

标准包数据目录：

- macOS：`~/Library/Application Support/iLab GPT CONJURE/`
- Windows：`%APPDATA%\iLab GPT CONJURE\`

包含更新助手的 macOS 标准 App 会校验 signed `latest.json` 与 DMG SHA256，并在用户确认后自动覆盖、失败回滚和重新启动；`v0.6.1` 及更早的 macOS 标准 App 需要先手动安装当前版本一次，Windows 标准 ZIP 仍手动替换。

## 免安装一键包

| 平台 | 适用设备 | 下载 | SHA256 |
| --- | --- | --- | --- |
| Windows x64 | Windows 10/11 x64 | [ilab-gpt-conjure_windows_portable_x64_0.8.0.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/ilab-gpt-conjure_windows_portable_x64_0.8.0.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/ilab-gpt-conjure_windows_portable_x64_0.8.0.zip.sha256.txt) |
| macOS Apple Silicon | M1/M2/M3/M4 | [ilab-gpt-conjure_macos_portable_arm64_0.8.0.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/ilab-gpt-conjure_macos_portable_arm64_0.8.0.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/ilab-gpt-conjure_macos_portable_arm64_0.8.0.zip.sha256.txt) |
| macOS Intel | Intel x64 | [ilab-gpt-conjure_macos_portable_x64_0.8.0.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/ilab-gpt-conjure_macos_portable_x64_0.8.0.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/ilab-gpt-conjure_macos_portable_x64_0.8.0.zip.sha256.txt) |

portable 自动更新 manifest：

- [latest.json](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.0/latest.json)

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
