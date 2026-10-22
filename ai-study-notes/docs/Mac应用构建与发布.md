# Mac 应用构建与发布

## 当前交付

Electron 独立应用，自带 Chromium 与 Node 运行环境，使用现有聊天和笔记界面。没有启动系统浏览器来代替主窗口，也不依赖电脑已安装的 Node、VS Code 或项目目录。ChatGPT 账号授权、外部网页和 Obsidian 笔记链接通过系统应用打开。

源代码与安装包在本项目中；大型构建依赖、中间 `.app` 和运行时下载位于 `/private/tmp/shiye-desktop-toolchain`，避免同步进 Obsidian/iCloud 仓库。源代码支持重新生成，临时构建目录可在应用与构建任务退出后删除。

## 构建

开发机需要 macOS、Node.js 22.19+、npm 和 Xcode Command Line Tools。安装后使用应用的人无需这些工具。

```sh
npm run desktop
npm run build:mac
```

首次构建按 `desktop/package-lock.json` 安装工具到临时目录，显式运行新版 Electron 的运行时安装器。可通过 `HTTPS_PROXY`、`HTTP_PROXY` 和 `ELECTRON_GET_USE_PROXY=1` 使用开发机代理；不要把代理凭据提交到项目。

依赖锁定为 Electron 45.0.0、electron-builder 26.15.3、Undici 8.12.3。应用内 Node 为 24.22.0，桌面版通过 Undici 统一设置 fetch 的代理，沿用 macOS 系统代理检测和本机请求直连；无需系统 Node 25 的代理功能。日常开发网页版仍使用原 Node 内置网络实现。

当前仅生成 Apple Silicon（arm64）安装包及对应 ZIP，文件名包含版本和架构，保存到 `release/`。构建入口拒绝 x64。Mac 最低版本为 13。组装和签名在临时目录进行，签名前只清理生成 `.app` 的扩展属性，避免 iCloud 附加属性破坏签名；不会修改系统安全配置。

## 文件范围与运行安全

打包使用白名单，应用代码只包含 `desktop`、`server`、`core`、`web`、`obsidian`、组件 ZIP 和生产依赖 Undici。明确不包含 `.data`、笔记目录、测试、截图、日志、源电脑路径配置、账号或 API Key。

当前构建配置额外将第三方说明与完整许可复制到应用 Resources 中。现有 0.2.1 DMG 未因此重新构建；核查发现该旧二进制没有显式包含 Electron 的许可文件，本次发布资料另附许可 ZIP。Undici 原许可保留在生产依赖中。来源与边界见 [第三方项目与许可](../THIRD_PARTY_NOTICES.md)，重新构建后应核对实际应用内许可文件，而不能只依据依赖缓存中存在这些文件作判断。

页面禁用 Node 集成，启用上下文隔离和沙箱。预加载层只开放选择仓库、导入、显示文件夹、安装可选插件等固定操作，并校验主窗口和主 frame。主窗口限制导航，外部网页进入系统浏览器，只允许 http(s) 与 Obsidian 打开笔记协议，禁止 file、脚本和命令协议。日常运行不开启开发者工具；显式调试启动可启用调试接口以供本机测试。

本机服务仅监听 `127.0.0.1`，继续使用连接码、HttpOnly Cookie、Origin 和 Host 检查。默认端口 17861；若被其他进程占用，应用不连接、不终止该未知进程，改用系统分配的空闲端口，偏好页显示实际地址和提示。扩展与插件此时需填写实际地址；退出旧工作台后重启可恢复默认端口。

## 数据、导入与更新

- `.app`：程序、界面、运行环境，只读使用，不保存个人数据。
- 所选仓库：正式 Markdown、附件，默认写入「拾页笔记」；导入旧版沿用原目录。
- `~/Library/Application Support/拾页/desktop.json`：仓库列表与当前仓库标识。
- `~/Library/Application Support/拾页/workspaces/<id>/.data/`：该仓库的聊天、草稿、用量、偏好、连接信息和网络配置。
- macOS 钥匙串：账号与 API 凭据，服务名沿用原 `instanceId`。

旧版导入仅复制 `state.json`、`connection.json`、可选 `network.json`，校验数据与笔记路径，暂存后原子移入。原项目不修改、原笔记不搬动。已建立的仓库拒绝重复导入覆盖。不同仓库分开保存状态，选择已有仓库恢复原状态。损坏或未知版本的数据不会被静默初始化覆盖。

导入前应停止旧版；导入后应使用应用版，避免两份状态继续分叉。连接标识保留不等于保证所有机器沿用登录：另一台 Mac 没有原钥匙串项，需要自行授权或填写 API Key。应用数据目录含本机连接信息，不应随安装包公开分享。

更新先退出应用，替换 `.app`，不清空应用数据。当前无需转换原 state v1 数据格式；将来变更时应增加版本迁移与迁移前备份。自动更新尚未上线，现有 blockmap/ZIP 只是构建产物。

## 正式签名与公证

未配置开发者身份时，构建使用临时签名 `-`。当前 0.2.1 安装包没有完成 Developer ID 签名和 Apple 公证，应标为测试版；网络下载到其他 Mac 不能保证直接双击即开。

有 Developer ID Application 证书后，设置 `SHIYE_SIGN_IDENTITY` 为实际证书名，构建会启用 Hardened Runtime。需要公证时设置 `SHIYE_NOTARIZE=1`，并通过 electron-builder 支持的 Apple 凭据环境变量提供公证身份；不要写入源码或安装包。正式发布前重新验证签名、公证票据和 Gatekeeper，不能只凭构建成功宣称已公证。

参考：[Electron 签名与公证](https://www.electronjs.org/docs/latest/tutorial/code-signing)、[electron-builder Mac 配置](https://www.electron.build/v26/docs/mac/)、[Apple 首次打开 App](https://support.apple.com/zh-cn/102445)。

## 验证

```sh
npm test
npm run check
mkdir -p .artifacts
node tests/desktop_check.mjs
```

核心测试无需额外依赖。桌面检查还需要 Playwright；通过 `SHIYE_PLAYWRIGHT` 指向其 JavaScript 入口模块的绝对路径，默认值仅是本地测试工具缓存约定。桌面检查默认读取临时构建目录中的 Apple Silicon `.app`，可用 `SHIYE_APP_BINARY` 指向从 DMG 复制出来的程序。用独立临时数据与合成笔记，运行环境 PATH 只包含系统目录，检查不依赖 Homebrew Node；不调用真实模型，不修改学习笔记。`SHIYE_APP_DATA` 可指定测试用独立数据目录。

Apple Silicon 安装版在当前 Mac 实测，不再制作 Intel 新版本。原生全屏关闭回归使用 `node tests/window_check.mjs`，必须单独串行运行，不能与其他会争抢前台的桌面检查并行。可用 `SHIYE_APP_BINARY` 指向要检查的安装版；`--baseline` 记录旧版行为而不要求通过修复后的断言。

## 整理 GitHub 发布资料

在核心检查通过、同版本 arm64 DMG 构建并验收后运行。此整理命令另需 `python3`，仅使用其标准库生成带 UTF-8 文件名的源码 ZIP，无需安装 Python 依赖：

```sh
npm run prepare:github
```

命令只整理本机文件，不访问 GitHub，不创建仓库、不提交或上传。它按明确的源码文件范围复制，排除个人数据、笔记、日志、构建依赖、旧安装包和 Intel 包；校验常见凭据格式，生成源码 ZIP、DMG 校验值、上传步骤与 Release 说明。输出在 `github-publish/v<版本>/`，重复执行会替换该版本自动生成的资料。不要在这个生成目录内保存唯一的手工修改。

已构建 DMG 按字节复制，不会因为文档整理重新打包。`release/安装包清单.json` 只有在版本、文件名和文件大小匹配时才附带；新版本应重新记录实际验收结果。若尚未提供该版本 Release 文稿，会使用保守模板，发布前按实际改动补充。

上传仓库源码与上传 Release 附件是两个步骤，详见 [GitHub 发布指南](GitHub发布指南.md)。发布资料不包含自动更新清单或 blockmap，当前应用不会在线检查更新。

## 0.2.1 窗口生命周期

0.2.0 在 `close` 中直接隐藏原生全屏窗口，没有结束 macOS 的全屏 Space。0.2.1 保留窗口页面和未提交内容，但等待 `leave-full-screen` 完成后再恢复正常尺寸并隐藏。不能使用固定延时或仅凭同步 `isFullScreen()` 值判断动画完成，参见 [Electron 原生全屏异步说明](https://www.electronjs.org/docs/latest/api/base-window#winsetfullscreenflag)。

`desktop/window-lifecycle.mjs` 统一处理关闭、Dock 激活和菜单全屏切换；动画中重复关闭合并，Dock 激活以最后的显示意图为准。普通位置仅在稳定状态记录，恢复时按当前屏幕工作区校正，并重设最小窗口尺寸，避免微小或离屏窗口。完全退出时取消待执行的窗口回调。
