# 第三方项目与许可说明

拾页使用以下第三方开源组件。这里列出可由当前源码、依赖清单、锁文件和安装的组件核实的来源；版本以本次发布为准。

## 直接使用的项目

| 项目 | 版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 45.0.0 | Mac 应用窗口和内置 Chromium / Node.js 运行环境 | MIT；内部第三方组件分别保留原许可 |
| [Undici](https://github.com/nodejs/undici) | 8.12.3 | 桌面版 HTTP 请求与代理适配，作为运行依赖随应用分发 | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | 26.15.3 | 构建 `.app`、DMG 和应用 ZIP，属于构建工具 | MIT |
| [Playwright](https://github.com/microsoft/playwright) | 测试环境提供，未锁入应用依赖 | 网页、扩展和 Electron 自动化验证，不随应用分发 | Apache-2.0 |

当前测试环境中的 Playwright 包为 `playwright-core@1.64.0-beta-1791568591000`。这只是已使用的测试工具版本，不要求使用者采用该预览版本。Electron、electron-builder 和 Undici 的精确依赖记录位于 `desktop/package.json` 与 `desktop/package-lock.json`。构建工具的间接依赖也保留其各自许可证，不将全部组件概括为 MIT。

## 许可证原文

下列文件直接复制自相应版本的安装包，保留原版权声明与文本。来源与摘要见 [SOURCES.json](docs/third-party/SOURCES.json)。

- [Electron LICENSE](docs/third-party/Electron-LICENSE.txt)
- [Electron 随附的 Chromium 及其他第三方组件许可](docs/third-party/LICENSES.chromium.html)
- [Undici LICENSE](docs/third-party/Undici-LICENSE.txt)
- [electron-builder LICENSE](docs/third-party/electron-builder-LICENSE.txt)
- [Playwright LICENSE](docs/third-party/Playwright-LICENSE.txt) 与 [NOTICE](docs/third-party/Playwright-NOTICE.txt)

Electron 的完整许可清单中包括多种许可证、版权归属和项目链接，应保留完整原文。这里的项目表只说明直接采用的组件，并不代替其内部第三方清单。

## 与其他产品、项目的关系

Obsidian 是笔记文件与可选插件的宿主；ChatGPT、OpenAI API 和 DeepSeek 是可选连接的模型服务；幕布用于接收复制的大纲文字。支持这些产品不表示复制其产品源码，也不表示获得其官方背书。

当前项目文件没有记录某个现成的聊天或笔记应用作为 fork / 改造上游。根据现有记录，可以确认上述组件依赖；不能仅凭未发现记录就宣称所有实现均为原创。如果后续引入其他项目的代码、素材或模板，应补充具体来源、使用范围、修改情况和原许可证。

## 本次发布中的位置

公开源码包含本说明和 `docs/third-party/` 中的原文。GitHub Release 另附 `Shiye-<版本>-third-party-notices.zip`，请与 DMG 一起上传、保留；其中包含同一份说明与许可文本。

现有 0.2.1 DMG 保持已验收的二进制不变。核查发现，其 `.app` 未显式包含 Electron 的两份许可文件，因此本次发布资料另附完整许可 ZIP；不能把这次补文档表述为旧安装包内部已经补齐。源码的后续构建规则已增加 `Contents/Resources/third-party-licenses/` 与 `THIRD_PARTY_NOTICES.md`，重新构建后仍需检查实际产物。

拾页自身尚未选择开源许可证。本说明只确认第三方来源与原许可，不为拾页自动附加 MIT、Apache 等项目授权。
