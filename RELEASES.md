# 下载 / Releases

当前正式版本：[v0.8.1](https://github.com/kadevin/ilab-conjure/releases/tag/v0.8.1)

## 版本说明

当前版本：`v0.8.1`。这是面向 Windows 用户的重要修复版本。建议正在使用 `v0.8.0` 的 Windows 标准版和 portable 一键包用户尽快更新。

本版重点：修复部分 Windows 环境无法原子保存设置和任务数据的问题，以及本机代理可能导致生成、编辑、设置保存和任务已读操作返回 `403` 的问题。

本版详情：

### Windows 用户请更新

- 修复部分 Windows Python 环境缺少 `os.fchmod` 时，设置或任务数据保存失败并显示 Internal Server Error 的问题。
- 修复 Windows 使用系统代理、本机代理或代理软件时，转发头可能让本地 WebUI 把正常同源写请求误判为跨源请求的问题。
- 受影响时，生成、编辑、设置保存和任务已读等操作可能返回 `403 Cross-origin WebUI request rejected`；更新后本地服务不再信任无关代理头，原有同源和仅限本机访问保护保持不变。
- 标准版用户需要退出旧程序，下载并解压新的 Windows 标准包后替换旧程序文件；portable 用户可以通过托盘菜单检查更新，也可以下载完整一键包覆盖程序文件。
- 更新不会迁移、重置或删除已有设置、任务数据库、历史图库、输入图和输出图。

macOS 用户不受上述 Windows 原子写入问题影响；如果当前使用正常，可以按需更新。

## 推荐下载

| 平台 | 推荐给 | 下载 | SHA256 |
| --- | --- | --- | --- |
| macOS Apple Silicon | 新用户，M1/M2/M3/M4 | [iLab-GPT-CONJURE-macos-arm64-0.8.1.dmg](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/iLab-GPT-CONJURE-macos-arm64-0.8.1.dmg) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/iLab-GPT-CONJURE-macos-arm64-0.8.1.dmg.sha256.txt) |
| macOS Intel | 新用户，Intel x64 | [iLab-GPT-CONJURE-macos-x64-0.8.1.dmg](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/iLab-GPT-CONJURE-macos-x64-0.8.1.dmg) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/iLab-GPT-CONJURE-macos-x64-0.8.1.dmg.sha256.txt) |
| Windows x64 | 新用户，Windows 10/11 x64 | [iLab-GPT-CONJURE-windows-x64_0.8.1.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/iLab-GPT-CONJURE-windows-x64_0.8.1.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/iLab-GPT-CONJURE-windows-x64_0.8.1.zip.sha256.txt) |

标准包数据目录：

- macOS：`~/Library/Application Support/iLab GPT CONJURE/`
- Windows：`%APPDATA%\iLab GPT CONJURE\`

包含更新助手的 macOS 标准 App 会校验 signed `latest.json` 与 DMG SHA256，并在用户确认后自动覆盖、失败回滚和重新启动；`v0.6.1` 及更早的 macOS 标准 App 需要先手动安装当前版本一次，Windows 标准 ZIP 仍手动替换。

## 免安装一键包

| 平台 | 适用设备 | 下载 | SHA256 |
| --- | --- | --- | --- |
| Windows x64 | Windows 10/11 x64 | [ilab-gpt-conjure_windows_portable_x64_0.8.1.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/ilab-gpt-conjure_windows_portable_x64_0.8.1.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/ilab-gpt-conjure_windows_portable_x64_0.8.1.zip.sha256.txt) |
| macOS Apple Silicon | M1/M2/M3/M4 | [ilab-gpt-conjure_macos_portable_arm64_0.8.1.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/ilab-gpt-conjure_macos_portable_arm64_0.8.1.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/ilab-gpt-conjure_macos_portable_arm64_0.8.1.zip.sha256.txt) |
| macOS Intel | Intel x64 | [ilab-gpt-conjure_macos_portable_x64_0.8.1.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/ilab-gpt-conjure_macos_portable_x64_0.8.1.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/ilab-gpt-conjure_macos_portable_x64_0.8.1.zip.sha256.txt) |

portable 自动更新 manifest：

- [latest.json](https://github.com/kadevin/ilab-conjure/releases/download/v0.8.1/latest.json)

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
