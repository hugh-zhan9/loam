<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Loam 应用图标" width="128" height="128">
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

# Loam

**macOS 上的本地优先 Markdown 工作台——原始笔记在这里沉降成知识。**

Loam 是壤土：腐殖质与矿物分层混成，上面那层养着从里面长出来的东西。这个应用就是这个形状——笔记始终是你自己的纯 Markdown 文件，上面叠两层：LLM wiki 把原始素材变成互链的文章，记忆库把它变成 agent 能读到的结论。没有任何东西存成别的编辑器打不开的格式。

磁盘上唯一要紧的东西是 Markdown 文件。其余的（布局、标签页、草稿、记忆）都是派生物，放在应用旁边，而不是塞进你的笔记里。

## 两个窗口

- **工作区**——启动应用、恢复上次的文件夹、或打开一个文件夹时出现。单根目录，一份笔记列表，标签页、大纲、搜索，以及知识相关的功能。
- **单文档**——Finder 或"打开方式"把一个 `.md` / `.markdown` 交给它时出现。只有编辑器和这份文档的大纲：没有文件树，没有标签页。它不受 `loam-cli` 驱动，也不恢复上次的工作区。

只打开和列出 `.md` 与 `.markdown`。

## 工作区

从左到右三栏：

1. **导航栏**——带计数的笔记分组，以及文件树。文件树可以只盯着某一个文件夹（比如 `raw/`），笔记列表和计数会跟着它一起收窄。
2. **笔记列表**——每条笔记一张卡片：标题、两行摘要、相对时间，最近编辑在前。滚动时分页加载，所以两万多条笔记的文件夹和十条的打开一样快。右键可以在 Finder 中显示、复制路径、移到废纸篓。
3. **编辑器**——右侧大纲栏可以收起。

导航栏和列表的宽度互相独立、按工作区记住，"只看某个文件夹"这个选择也一样。

## 编辑

一份文档，两张脸，**⌘⇧M** 切换：

- **可视**——渲染后的文档，就地编辑（Milkdown/ProseMirror）。
- **源码**——Markdown 本身（CodeMirror），同一个文件，同一处选区。

编辑器认得：标题、列表、表格、脚注、callout、frontmatter、任务列表、行内与块级公式（KaTeX）、Mermaid 图、wikilink（`[[目标|别名]]`），以及粘贴或拖进来的图片。

有几处是想过才这么定的：

- **链接用 ⌘ + 点击打开**，而且只有按住 ⌘ 时指针才变成手型。普通点击是把光标放进标签文字里——因为链接的文字就是文字，总有人要改它。光标进入链接时会出现一个字段，里面是它的地址：`[标签](地址)` 里被渲染隐藏掉的那一半。
- **图画出来之后，它自己把源码收起来。** 光标进入这个块时源码回来，而点图正是把光标放进去的动作。画不出来的图永远把源码留在屏幕上。
- **代码块里按 ⌘A 取的是这段代码**，再按一次才是整篇笔记。
- **PDF 就是系统打印对话框**作用在渲染后的文档上。没有第二个排版器，所以导出的页面不可能和你编辑时看到的不一致。

## 知识

### LLM wiki

给把原始素材放在 `raw/` 下的工作区用：导入一个文件、就某个题目生成、检查结果、提问。走你在「设置 → LLM」里配的 OpenAI 兼容端点。工作区窗口和 CLI socket 都能用。

### 记忆

两层，而这个区分就是整个功能的骨架：

- **素材**是发生过的事——一条决定、一个发现、一段对话——原样存着，带出处，不代表任何判断。
- **结论**是你从素材里读出的意思。它引用素材，先以候选存在，只有被采纳、并通过门禁（要有支持证据、且没有挂着的反例）之后，才会进入 agent 的上下文。

打开它需要一次联网：面板会把嵌入模型（`minishlab/potion-multilingual-128M`）下载到 `~/.loam/models/`。写入和语义检索都要用它，而且**没有降级模式**——没有模型时写入会被拒绝，而不是悄悄退化成关键词匹配。下载完之后完全离线运行。

你自己用记忆，不需要装别的东西。让 Claude Code / Codex / Cursor 读到它是另一件事，需要你主动去装（记忆 → Agent 集成）：它会写入一个技能、若干 hook，以及一个指向随包 `loam-mcp` 的 MCP server。

完整说明见 [docs/memory-usage.md](docs/memory-usage.md)。

**如实说明当前状态**：存素材与语义检索**已在真实模型、真实库上验证**——1020 条素材，写入后按相关度检索，新写的那条排第一。结论那一半（`distill` → `gate` → `adopt`）实现了、有单元测试，但**还没在真实模型下端到端跑过**，所以目前还没有任何东西是通过这条路进到 agent 上下文里的。

`delete` 只是隐藏一条；`purge` 才是真删并把文件的页还给磁盘——**这里唯一不可逆的操作**。

## 外观

十个内置主题——浅色三个（系统浅色、纸感、石墨）加两个（白昼，对比度拉满；青瓷，冷调但不是灰），深色三个（系统深色、午夜、墨蓝）加两个（暖褐，不含蓝调的深色；曜石，近黑且对比最高）——以及**跟随系统**。

标题栏上那个衣服图标打开外观，在那里还可以**自己做一个主题**：十个颜色，每个都从当前屏幕上的主题起步，保存成 `~/.loam/themes/` 里一份普通的 `.css` 文件。那份文件写的是和手写主题同一套公开契约（`--mdx-theme-*`，见 [docs/loopx/specs/theme.md](docs/loopx/specs/theme.md)），由同一个解析器读回来——所以应用里做的主题能用编辑器改，手写的主题也能在应用里打开。主题是数据：选择器、`@import`、`url()` 一律不会被提取。

主题下面可以给正文垫一张**背景图**。只铺在正文那一栏——侧栏和标题栏保持实色，那里字小且密，是最先在图上读不清的地方——浓淡由一个滑杆决定。调淡的做法是把主题自己的底色重新盖回图上，而不是把文字一起调淡，所以正文的对比度还是主题给的那个，同一张图换到深色主题下会自己变暗。图片会复制到 `~/.loam/background/`，之后移动或删掉原图都不影响；打印时不会带上。它**不是**主题属性：主题不能加载任何东西，这条正是"一个陌生主题可以放心试"的来源。

## 东西都放在哪

| 路径 | 内容 |
| --- | --- |
| `~/.loam/state.json` | 窗口尺寸、标签页、栏宽、文件树盯着哪个文件夹 |
| `~/.loam/drafts/` | 未保存的正文，纯文本；保存后删除，过期 30 天清理 |
| `~/.loam/themes/` | 你自己的主题 |
| `~/.loam/background/` | 背景图，同时只留一张 |
| `~/.loam/models/` | 嵌入模型 |
| `~/.loam/memory/palace.db` | 一个记忆库服务所有工作区，按项目区分 |
| `~/.loam/assets/` | 没有更好去处的图片的兜底位置 |
| `~/.loam/cli.sock` | `loam-cli` 说话用的 socket |
| `<工作区>/.assets/` | 粘进笔记的图片 |
| `<工作区>/.loam/` | 这个工作区的记忆配置 |

记忆跟着机器走，不跟着仓库走：把笔记 clone 到别处不会把记忆带过去，要带就导出一份备份包。

## CLI 与 MCP

`loam-cli` 通过 `~/.loam/cli.sock` 驱动正在运行的工作区窗口：

```bash
loam-cli new | list | open <路径> | focus | save | close
loam-cli content | selection | insert <文本>
loam-cli create-file <目录> [名字] | create-folder <目录> <名字> | rename <路径> <名字>
loam-cli llm-wiki status | ingest <raw 路径> | digest --title "..." <提示...>
loam-cli llm-wiki lint | query <问题...> | search <关键词...>
loam-cli serve --workspace <工作区> --port 14243
```

记忆还可以脱离窗口、直接对着一个工作区跑：

```bash
loam-cli memory --root <工作区> init | status | doctor | model | reindex
loam-cli memory --root <工作区> add --body "..." | --file <路径> | --stdin
loam-cli memory --root <工作区> show | list | delete | purge [--before <ISO时间>]
loam-cli memory --root <工作区> search | context | brief | recall <查询...>
loam-cli memory --root <工作区> distill | gate | adopt | demote | promote
loam-cli memory --root <工作区> capture | legacy-import | export | import
loam-cli memory --root <工作区> agent setup [--all|--claude|--codex|--cursor] [--dry-run]
```

每条命令自己的 `--help` 才是准的，上面这份是地图不是契约。给 agent 用的 MCP：

```bash
loam-mcp --workspace <工作区>
```

打包后的应用把 `loam-cli` 和 `loam-mcp` 作为 sidecar 带在
`/Applications/Loam.app/Contents/MacOS/` 里。

## 构建

```bash
npm install
npx tauri dev          # 桌面端，附带渲染层的开发服务器
npm run dev            # 只起渲染层，用于调 UI——它不是一个 Web 产品
npx tauri build        # 产出 .app 与 .dmg
./scripts/build-install.sh  # 一键构建 .app 并替换 /Applications/Loam.app
npm run build:install  # 调用同一个 Shell 脚本
npm run build:app      # 只构建 .app
npm run install:local  # 安装已经构建好的 .app
```

安装脚本 `scripts/install-local-app.mjs` 会先复制、签名并验证新包，再替换旧应用。安装前请保存编辑并关闭 Loam；应用仍在运行或签名失败时，脚本会停止并保留旧包。成功后会输出旧包备份路径；文档和应用数据不在替换范围内。可以用 `LOAM_BUILT_APP`、`LOAM_INSTALL_APP` 指定构建包和安装位置。安装后运行 `open /Applications/Loam.app` 启动。

往 `app/globals.css` 里加主题需要先清渲染层缓存——`rm -rf .next`——因为 Turbopack 会在热更新时重新输出改过的规则，但**不会**重新解析声明调色板用的 `@plugin`。

## 验证

```bash
npm run lint
npm run test
npm run audit:editor:boundaries
cd src-tauri && cargo test
```

其中边界审计值得知道：如果产品代码直接 import 了 Milkdown、ProseMirror 或 CodeMirror，查询了编辑器私有 DOM，或者深度 import 了编辑器包，它就会失败。编辑器只通过一个入口和一套钉住的命令词汇表对外，这正是它底层的编辑器能被整个换掉、而产品层毫无察觉的原因。

## 架构

- **前端**——Next.js 16、React 19、TypeScript、Tailwind CSS 4 + daisyUI
- **桌面外壳**——Tauri 2、Rust
- **编辑器**——可视面用 Milkdown/ProseMirror，源码面用 CodeMirror，两者藏在 `packages/mdx-editor/` 的同一个适配器后面；Markdown 是唯一被持久化的形态
- **高亮**——Prism
- **记忆**——mempal，一个内嵌库，自带 SQLite schema
- **测试**——前端用 Vitest，Rust 侧用 `cargo test`

前端拥有工作区状态、标签页、大纲解析、栏宽和编辑器集成。Rust 拥有文件系统访问、应用状态、图片资源、废纸篓、CLI socket、LLM wiki 流水线和记忆库。

## 范围

只支持 macOS。每个工作区一个根目录。没有 Web 产品、没有 Quick Look 扩展、没有自动更新、不搜索 PDF 与图片内部的文字。

## 许可

MIT，见 [LICENSE](LICENSE)。
