# dsh-filexplore

DeepSeek Harness web 插件：**文件拖拽 / `@` 文件引用 + 右侧常驻文件浏览器（Git 状态）+ 多 tab 文件查看器（语法高亮 / Markdown 渲染，支持手动编辑保存）**。

## 功能

1. **拖拽入库**：把任意文件（非纯图片）拖到聊天输入框 → 文件自动写入当前会话工作区的 `attachments/` 目录，并在输入框末尾插入一个 `@file <路径>` 引用 chip。纯图片拖拽仍走 dsh 原生图片通道。
2. **@ 文件引用**：在输入框输入 `@` 会弹出候选菜单（与子智能体 @ 共存），列出当前会话工作区里的文件；选中后插入文件引用 chip。
3. **右侧常驻文件浏览器（真四栏布局）**：侧边栏工作区行右侧的文件夹按钮（悬停显示）打开 dsh 布局系统新增的第四列 `right`（对 `@deepseek-ai/dsh-client-ui-layout` 的本地补丁，见 `patches/`）——对话区**真正 reflow 变窄**而非被覆盖，右列自带原生拖拽把手调节宽度（320–760px）。列内顶部为文件浏览器（懒加载文件树 + **Git 状态徽标** U/M/D/R/A/!，每 5 秒刷新），底部为文件的查看器，中间有分隔条拖动调节上下高度。
4. **多 tab 文件查看器 + 自动样式**：点击文件 → 在右列下半打开多 tab 查看器。按扩展名自动识别语言并**语法高亮**（JS/TS/JSON/Python/Go/Rust/Java/C/C++/C#/Swift/Kotlin/Dart/Ruby/PHP/Shell/SQL/YAML/TOML/CSS/HTML 等约 30 种；字符串/注释/数字/关键词/函数调用/类型分色，SQL 大小写不敏感）；`.md`/`.markdown` 走**轻量 Markdown 渲染**（标题/列表/引用/代码围栏带行号高亮/加粗/斜体/行内代码/链接/分隔线）；其余以等宽纯文本展示；二进制与超大文件给出提示。
5. **手动编辑保存**：查看器点「**编辑**」进入文本编辑（textarea，**Ctrl/⌘+S** 保存、**Esc** 取消，切换 tab / 关闭时有未保存修改会确认）；「保存」通过 host `POST /filexp/write` 写回磁盘，tab 上 `●` 表示未保存；二进制 / 截断文件禁编辑。保存后浏览器里的 Git 状态徽标自动刷新为 `M`。
6. **`@` 引用路径规则**：查看器「插入引用」把当前 tab、浏览器每行悬停的 `+` 也可直接插入 `@file <路径>` 引用；**同一工作区用相对路径，跨工作区自动用绝对路径**，保证 agent 总能解析到文件。

发送时 chip 序列化为 `@file <相对路径>`，agent 可用自带的 read / bash 等工具直接读取该文件。

## 工作原理

| 半边 | 文件 | 职责 |
|------|------|------|
| Host 插件 | `lib/index.js` | `GET /filexp/list`、`GET /filexp/tree`、`GET /filexp/status`（git porcelain）、`GET /filexp/file`（读文本，二进制/超限检测）、`POST /filexp/write`（手动编辑写回文件）、`POST /filexp/intake`（拖拽入库到 `attachments/`） |
| Client 插件 | `lib/client.js` | 注册 `@` 触发源 `file`；捕获阶段 drop 监听；MutationObserver 注入工作区行按钮；React 右侧常驻文件浏览器 + 多 tab 文件查看器（语法高亮 / Markdown 渲染 / 编辑保存，接入布局 `layout.right` 列） |

引用格式约定：`@file <相对路径>`（相对会话 cwd）。菜单与 chip 里的 label 是文件名，完整相对路径作为副标题 / title。

## 安装（web profile）

```bash
# 1. 让 dsh 能解析到本包（二选一）
#    a) 官方路径（需要 pnpm）：
dsh plugin --profile web add /path/to/dsh-filexplore
#    b) 无 pnpm 时，软链到 flat fallback：
ln -s /path/to/dsh-filexplore ~/.dsh/profiles/node_modules/dsh-filexplore

# 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 追加：
#    - insert:
#        - id: dsh-filexplore
#          name: 'dsh-filexplore'

# 3. 重启 dsh web（HMR 在 web profile 默认关闭，新增 entry 需重启生效）
```

## 限制

- 单文件 ≤ 32 MiB，单次 intake ≤ 64 MiB（超出部分跳过并打印 warning）。
- 文件列表只扫会话 cwd 下最多 4 层，跳过 `node_modules` / `.git` / `.dsh` / `dist` / `build` 等噪音目录，最多返回 400 条。
- 文件树每层最多返回 1000 条，跳过隐藏文件与噪音目录；查看器文本读取上限 1 MiB（超出截断提示），二进制文件不预览；查看器单文件最多渲染 3000 行。
- 右列复用 dsh 布局原生第四列：对话区真实 reflow；右列宽度原生拖拽调节，浏览器/查看器高度用列内分隔条调节。
- ⚠️ 依赖对 `@deepseek-ai/dsh-client-ui-layout` 的本地补丁（`patches/dsh-client-ui-layout.client.js`）。dsh 升级重装 node_modules 后需重新应用该文件。
- 文件写入 `attachments/` 后不会自动删除；拖拽只在有会话打开时生效。
- 同名文件自动追加 `-1`、`-2` 后缀去重。
- 混合拖拽（图片 + 其他文件）时整批都按文件引用处理，图片不再走原生图片通道。
