# 下载 / Releases

当前正式版本：[v0.7.3](https://github.com/kadevin/ilab-conjure/releases/tag/v0.7.3)

## 版本说明

当前版本：`v0.7.3`。本版重点解决程序长时间运行时可能出现的持续硬盘写入、任务状态不同步和退出不完整问题，同时加强本地数据、参考图和 API Key 的保护，并修复近期反馈的多项界面问题。建议经常并发生成、多图生成或长期保持程序运行的用户更新。

本版重点：降低空闲状态下的磁盘写入，提升任务队列、取消和程序退出的可靠性；升级不会迁移、重置或删除已有设置、任务数据库、历史图库、输入图和输出图。

本版详情：

### 硬盘写入与队列稳定性

- 修复队列空闲时仍可能持续访问任务数据库、造成高频硬盘写入的问题。
- 空闲状态不再反复检查所有供应商通道；只有新增任务、重试、设置变化或程序恢复时才唤醒队列。
- 运行中的任务按实际开始顺序稳定排列，新开始的任务追加在后面，不再出现顺序来回跳动。
- 修复刷新任务列表或删除其他任务后，多图任务的多个生成状态指示变成单个的问题。
- 修复等待任务切换为运行中时，任务卡短暂显示不一致状态或明显卡顿的问题。

### 任务取消与程序退出

- 取消运行中的任务后会显示“正在取消”。服务商调用真正返回前，任务仍保留运行槽位，避免后续任务过早开始或并发数量失真。
- 取消提示会明确说明：已经发出的服务商调用在返回前可能仍会继续，也可能仍会计费。
- 正常关闭标准 App、portable 一键包或源码运行程序时，未完成且未被用户取消的任务会回到等待队列，重新启动后继续。
- 优化启动器和快捷启动脚本的进程管理，减少程序关闭后仍残留 WebUI 服务或日志进程的情况。
- 同一数据目录只允许一个程序实例运行。重复启动时只会提示关闭已有实例，不会尝试重置数据库或清理历史文件。

### 生成页与历史库修复

- 任务完成通知现在会显示在大图查看层上方，不再被图片遮住。
- 历史库滚动到中间或后面查看任务时，新任务完成不会再把页面拉回顶部。
- 精选、取消精选或删除未精选图片后，任务继续保持已读状态。
- 统一创建任务前后的预览区域尺寸，减少右侧预览框瞬间放大、缩小的闪动。
- 运行状态动画在任务卡刷新后保持连续，减少等待和运行状态切换时的视觉跳动。
- 放大任务卡悬浮操作图标和停止图标，改善图标与按钮外轮廓比例。
- “正在取消”的任务会保持明确状态，避免被重复删除或错误显示为已结束。

### 最近上传与参考图保护

- 未被任何任务引用的最近上传图片可以永久删除，并从当前输入中移除同一图片。
- 已被任务引用的图片不再允许永久删除，只能从“最近上传”栏隐藏；原图、当前输入和历史任务预览都会保留。
- 再次上传相同图片时，之前隐藏的图片会重新出现在最近上传栏。
- 自动整理最近上传图片时会跳过仍被任务引用的素材，避免历史任务参考图意外丢失。
- 修复最近上传图片的删除按钮顶部被裁切的问题。
- 修复横向滚动到后续图片时，缩略图必须经过鼠标悬停才开始加载的问题。

### 提示词与供应商设置

- 原始模式严格按用户输入的原文发送，不再追加应用级比例文字或保真指令。
- 保真模式根据提交任务时的界面语言生成约束，并在任务创建时固定下来。
- 排队、重试和程序重启不会重新翻译提示词，也不会重复追加比例或保真说明。
- API Key 按协议、主机和端口进行隔离。只修改同一中转站内的路径时继续保留已有 Key。
- 主动更换协议、域名或端口时，需要同时输入新地址对应的 API Key，防止旧 Key 被误发到其他服务。
- 已经排队的任务不会因为后来更换供应商地址而误用新地址的 Key；需要确认设置后重新提交。

### 本地数据与资源保护

- 加强本机访问限制，拒绝其他网站对本地 WebUI 发起写入操作。
- 任务数据库、设置、任务记录和调试文件不会作为普通静态文件提供。
- 任务图片只有在能够确认属于对应任务时才允许访问，未归属文件不会意外暴露。
- 加强上传图片、服务商返回结果和大文件下载的有效性与资源限制，防止损坏文件或异常大的内容占用过多内存和磁盘。
- 生成请求会先完成输入、供应商和参数检查，再创建任务和保存素材；提交失败不会留下孤立任务或误删已有文件。
- 多图 ZIP 下载增加总量保护，打包失败不会修改原始图片。

### 安装与升级

- 标准包和 portable 包自带的依赖已经匹配时，不会额外安装依赖。
- 使用旧 `.venv` 的源码或快捷脚本启动方式，首次运行新版时可能显示 `Installing WebUI dependencies...`，完成后即可正常启动。
- 依赖安装失败只会阻止本次启动，不会删除或重置设置、任务、图库和图片。
- 升级前应先退出旧实例；如果提示数据目录正在使用，只需关闭旧程序后重试。
- API 地址没有变化时，升级不要求重新输入 API Key。
- 已有设置、任务数据库、历史图库、输入图和输出图全部保留，不需要重置配置或手动迁移。
- `v0.5.4` 及更早 portable 用户首次升级到当前版本时，建议手动下载完整标准包或完整 portable 包；旧 updater 只保证升级 WebUI/依赖，不保证安装新的小兔子启动器、标准 `.app` / `.exe` 入口和迁移助手。

## 推荐下载

| 平台 | 推荐给 | 下载 | SHA256 |
| --- | --- | --- | --- |
| macOS Apple Silicon | 新用户，M1/M2/M3/M4 | [iLab-GPT-CONJURE-macos-arm64-0.7.3.dmg](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/iLab-GPT-CONJURE-macos-arm64-0.7.3.dmg) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/iLab-GPT-CONJURE-macos-arm64-0.7.3.dmg.sha256.txt) |
| macOS Intel | 新用户，Intel x64 | [iLab-GPT-CONJURE-macos-x64-0.7.3.dmg](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/iLab-GPT-CONJURE-macos-x64-0.7.3.dmg) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/iLab-GPT-CONJURE-macos-x64-0.7.3.dmg.sha256.txt) |
| Windows x64 | 新用户，Windows 10/11 x64 | [iLab-GPT-CONJURE-windows-x64_0.7.3.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/iLab-GPT-CONJURE-windows-x64_0.7.3.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/iLab-GPT-CONJURE-windows-x64_0.7.3.zip.sha256.txt) |

标准包数据目录：

- macOS：`~/Library/Application Support/iLab GPT CONJURE/`
- Windows：`%APPDATA%\iLab GPT CONJURE\`

包含更新助手的 macOS 标准 App 会校验 signed `latest.json` 与 DMG SHA256，并在用户确认后自动覆盖、失败回滚和重新启动；`v0.6.1` 及更早的 macOS 标准 App 需要先手动安装当前版本一次，Windows 标准 ZIP 仍手动替换。

## 免安装一键包

| 平台 | 适用设备 | 下载 | SHA256 |
| --- | --- | --- | --- |
| Windows x64 | Windows 10/11 x64 | [ilab-gpt-conjure_windows_portable_x64_0.7.3.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/ilab-gpt-conjure_windows_portable_x64_0.7.3.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/ilab-gpt-conjure_windows_portable_x64_0.7.3.zip.sha256.txt) |
| macOS Apple Silicon | M1/M2/M3/M4 | [ilab-gpt-conjure_macos_portable_arm64_0.7.3.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/ilab-gpt-conjure_macos_portable_arm64_0.7.3.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/ilab-gpt-conjure_macos_portable_arm64_0.7.3.zip.sha256.txt) |
| macOS Intel | Intel x64 | [ilab-gpt-conjure_macos_portable_x64_0.7.3.zip](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/ilab-gpt-conjure_macos_portable_x64_0.7.3.zip) | [sha256](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/ilab-gpt-conjure_macos_portable_x64_0.7.3.zip.sha256.txt) |

portable 自动更新 manifest：

- [latest.json](https://github.com/kadevin/ilab-conjure/releases/download/v0.7.3/latest.json)

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
