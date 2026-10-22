# GitHub 发布指南

只上传整理好的项目源码与安装包，**不要上传整个 Obsidian 仓库或当前正在使用的项目文件夹**。

## 先找到准备好的资料

在项目根目录运行 `npm run prepare:github` 后，打开 `github-publish/v<版本>/`：

| 文件或文件夹 | 用途 |
| --- | --- |
| `01-源码/ai-study-notes/` | 这里面的全部内容上传到 GitHub 仓库根目录 |
| `02-Release附件/` | 这里面的文件上传到 GitHub Release 的附件区 |
| `Shiye-<版本>-source.zip` | 干净源码备份，可选附加到 Release；不能代替上传仓库源码 |
| `Release说明.md` | 创建 Release 时粘贴到说明框 |
| `先看我-上传步骤.md` | 本说明的独立副本 |
| `整理清单.json` | 文件数量、排除范围及 SHA-256 核对记录，不必上传 |

## 第一步：上传源码

1. 在 GitHub 创建一个新仓库，例如 `shiye` 或 `ai-study-notes`。简介可填：`本地 AI 对话与 Markdown 学习笔记工作台，支持 Obsidian 与大纲。`
2. 按自己的分享范围选 Public 或 Private。若使用下面的整包上传方法，创建时先不要勾选生成 README、`.gitignore` 或许可证。
3. 在仓库首页选择 **uploading an existing file**，或 **Add file → Upload files**。
4. 在 Finder 打开 `01-源码/ai-study-notes/`。按 `Command+Shift+.` 显示隐藏文件，选中里面所有文件和文件夹，拖到上传区域。应包含 `.gitignore` 和 `.gitattributes`。
5. 提交说明填 `准备拾页 v<版本> 源码与使用文档`，确认提交到默认分支。
6. 检查仓库首页能直接看到 `README.md`、`package.json`、`core/`、`server/`、`desktop/` 等，而不是只看到一个外层文件夹或 ZIP。

GitHub 不会把上传到 Code 区的 ZIP 自动展开成源码。`.gitignore` 用于 Git 提交规则，也不能代替网页上传前的筛选；使用已经整理好的源码文件夹即可。

网页版单文件上传限 25 MiB，单次最多 100 个文件；若后续源码文件数超过限制，可以分批上传或使用 GitHub Desktop。DMG 应放到 Release，普通仓库不接受大于 100 MiB 的单个文件。见 [GitHub 上传文件说明](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository) 和 [大文件说明](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)。

## 第二步：上传 Mac 安装包

1. 打开仓库 **Releases → Draft a new release / Create a new release**。
2. 标签填写 `v<版本>`，例如 `v0.2.1`；选择创建该标签，目标为刚才上传源码的默认分支。
3. 标题填写 `拾页 v<版本> · Apple Silicon 测试版`。
4. 打开同一发布目录的 `Release说明.md`，将正文复制到说明框。
5. 将 `02-Release附件/` **里面的所有文件**拖进附件区：DMG、`Shiye-<版本>-third-party-notices.zip`、`SHA256SUMS.txt`、`安装说明.txt`，以及存在时的 `安装包清单.json`。第三方许可 ZIP 与安装包一起发布；无需拖入整个资料目录。
6. 当前版本选 **Set as a pre-release（预发布）**。确认附件上传完成后，再点发布。

Release 附件区可承载安装包，单个附件上限 2 GiB。GitHub 会为标签另外提供源码 ZIP / TAR，通常不必再附上传准备好的源码 ZIP。见 [创建 Release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) 和 [附件限制](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。

## 已排除的内容与许可证

整理命令不包含 `.data/`、`.artifacts/`、`.test-vault/`、`笔记/`、`拾页笔记/`、`.obsidian/`、`node_modules/`、本机凭据、旧版/Intel 安装包和整个笔记仓库。原始学习数据仍保留在原处，整理不会移动或删除它们。

当前未选择开源许可证，因此没有自动添加 MIT、Apache 等授权文件。可以先按所需可见性保存仓库；若准备正式开源，再选择合适的许可证。公开可见和开源授权是不同事项，参见 [GitHub 许可证说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。

## 以后发新版

修改源码与版本记录 → 更新根目录 `package.json` 的版本 → 运行检查和测试 → 构建 arm64 DMG → 验收安装包 → 更新该版本发布文稿与验收清单 → 运行 `npm run prepare:github` → 上传源码改动并创建新标签/Release。

已有 Git 历史时继续提交改动，不要反复新建仓库。更新已发布安装包应使用新版本标签。当前应用通过退出后替换 `.app` 手动更新，没有在线自动更新。
