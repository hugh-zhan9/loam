# Memory Layer Contracts

> Memory 层与 LLM Wiki 层**并列**。本文档只描述 Memory 层契约；Wiki 契约见 [llm-wiki.md](./llm-wiki.md)。
>
> 使用说明见 [memory-usage.md](../../memory-usage.md)。设计与裁决见
> [2026-08-17-memory-engine-adoption](../design/2026-08-17-memory-engine-adoption/)。

## 模型

记忆有两层，界面上叫「素材」和「结论」：

| 层 | 是什么 | 谁会读到 |
|---|---|---|
| 素材（evidence） | 发生过的事，原文入库，带出处 | 检索命中时 |
| 结论（knowledge） | 从素材得出的判断，有状态 | **被采纳之后**才进 agent 的运行时上下文 |

素材进库不需要谁批准；结论要经人采纳才生效。被抛弃的三个旧概念——inbox（待确认）、working context、Markdown 投影——不存在，也没有等价物。

## 存储

- 全局单库 `~/.loam/memory/palace.db`，由 mempal 的 SQLite 存储层管理，schema 版本由上游决定。
- 工作区绝对路径 → 项目（wing）的绑定记在 `~/.loam/memory/wings.json`；项目名是「目录名 + 路径哈希前 6 位」，同名目录不会合并成一个项目。
- 工作区改名或移动后不自动认亲，需要显式重绑。
- 库比本版新（schema 不兼容）时整体只读并明确报错，**不自动迁移**。
- 库不可写时记忆整体停用，编辑器不受影响。
- 进程内一个库句柄，读写排队通过；跨进程只有 SQLite 写锁与上游 per-source 咨询锁。
- 只有 SQLite 一个后端。

## 嵌入模型

- 模型文件在 `~/.loam/models/<slug>/`，需要 `tokenizer.json`、`model.safetensors`、`config.json` 三件齐全。
- 齐全 → 零网络加载；不齐全 → `embedding_model_missing`，**写入与语义检索都不可用**，不降级成关键词模式。
- 下载是用户显式确认后的动作：下到临时目录，三件齐全再原子移入。
- 换模型或维度不符要走一次全量重嵌（`memory_reindex`）。

## 素材写入

三个入口，字段口径一致：

| 入口 | source_type | room | importance |
|---|---|---|---|
| 文件 / 目录 | 上游按格式判定 | 相对工作区根的首段目录，根目录下的文件用 `root` | 0 |
| 会话转录 | Conversation | `session` | 1 |
| 人工记录（含采纳确认、反例） | Manual | `note` / `review` | 1 |

- 身份是内容寻址的：同内容同来源写两次只有一条，并发写也只有一条。
- 我们自己拼装的条目显式带 `worktree://<工作区绝对路径>` 锚点；经上游 `ingest_file` 写入的文件素材带 `repo://legacy`，这不影响检索（上下文锚点链有 legacy 兜底），但项目路径的可发现性依赖前者。
- 素材进库后只能 soft-delete，`memory_purge` 才彻底清除。**没有入库前的等待区**。
- 飞书文档导出 JSON（`ok`、`data.doc_id`、`data.markdown`）先提取正文、解码一次 JSON 并把飞书表格标签转为可读行列，再使用既有切块与索引流程；原始来源路径保持不变。普通 JSON、正文中的代码转义保持原样。失败的文档导出响应或缺失正文报错，不把接口包装当素材写入。
- 已有错误分块的限定修复、引用保护和备份要求见 [飞书素材修复说明](../design/2026-09-18-memory-lark-import/修复说明.md)。

## 捕获

- 默认关闭，且只接受工作区配置里显式列出的 agent。
- 关闭或来源未列入时，捕获路径不写库、不写 spool、不排队，返回「未捕获」而不是失败。

## 结论生命周期

```
素材 → memory_distill（引用素材 id）→ 候选结论
     → memory_adopt（写人工确认证据 + 过门禁）→ 已采纳
     → memory_retire（带证据与理由类型）→ 已降级 / 已退役
```

- 可创建的层级只有两档：`concrete`（上游 `qi`）与 `pattern`（上游 `dao_ren`，门槛 ≥2 条支持证据）。上游的 `shu` / `dao_tian` 在 distill 阶段被拒绝，本产品不产生。
- 采纳会先写一条人工确认素材（含时间、确认人、结论 id、被复核的证据、可选备注），再作为验证证据提升。`enforce_gate` 恒为 true，`allow_counterexamples` 恒为 false。
- **不做批量采纳。**
- 门禁失败时把上游 `GateReport.reasons` 原样返回，不改写、不吞掉。
- 退役必须给证据引用与理由类型，理由类型只能是 `contradicted` / `obsolete` / `superseded` / `out_of_scope` / `unsafe`。
- 反例通过独立入口写入并挂到结论上；挂上之后该结论提不上去。

## 读取

| 面 | 返回 |
|---|---|
| `memory_search` | 混合检索（BM25 + 向量 + RRF）命中，每条带 `drawerId` 与 `sourceFile` |
| `memory_context` | 按 `dao_tian → dao_ren → shu → qi` 组装的结论包，`dao_tian` 默认最多 1 条，卡片默认不含 |
| `memory_brief` | 确定性摘要：事实、证据、不确定项、下一步，不调 LLM |
| `memory_recall` | 上面三者的组合，agent 的单一入口 |

`memory_recall` 的返回体是 `{ brief, context, hits, truncated }`。**不存在** `working` 与 `threads` 字段。

## 配置

**全局** `~/.loam/memory/config.json`：嵌入模型、检索默认值（`topK`、`contextMaxItems`、`daoTianLimit`、`includeCards`）。

**每工作区** `<workspace>/.loam/memory-config.json`（v3）：`enabled`、`capture.{enabled,sources}`、`agents.{claude,codex,cursor}.enabled`。

读到 v2 配置时按新默认重建并留 `.v2.bak`——配置不是用户数据，不写迁移器。

## 错误码

| 码 | 含义 |
|---|---|
| `memory_unavailable` | 库不可读写 |
| `schema_incompatible` | 库 schema 版本超出本版支持 |
| `embedding_model_missing` | 模型三件文件不齐 |
| `embedding_dim_mismatch` | 模型维度与库不一致，需先重嵌 |
| `memory_busy` | 写入锁等待超时 |
| `gate_failed` | 门禁未通过，`reasons` 原样透出 |
| `invalid_evidence_ref` | 引用的素材或结论不存在 |
| `invalid_evidence` | 空素材 |
| `invalid_conclusion` | 层级或退役理由类型不合法 |
| `wing_unbound` | 当前路径没有项目绑定 |
| `legacy_import_failed` | 旧数据导入整体失败 |
| `bundle_export_failed` / `bundle_import_failed` | 备份包读写失败 |

## Tauri 命令

`memory_status`、`memory_enable`、`memory_config_get`、`memory_config_set`、`memory_global_config_get`、`memory_global_config_set`、`memory_diagnostics`、`memory_projects`、`memory_rebind_project`、`memory_model_status`、`memory_model_download`、`memory_reindex`、`memory_search`、`memory_context`、`memory_brief`、`memory_recall`、`memory_add`、`memory_import_path`、`memory_list`、`memory_show`、`memory_delete`、`memory_purge`、`memory_distill`、`memory_gate`、`memory_adopt`、`memory_retire`、`memory_counterexample_add`、`memory_legacy_preflight`、`memory_legacy_import`、`memory_export_bundle`、`memory_import_bundle`、`memory_integration_status`、`memory_integration_repair`、`memory_agent_setup`。

`src-tauri/src/lib.rs` 的 `memory_tauri_command_tests` 同时钉住两件事：这份清单存在，以及被抛弃的命令没有以别名形式回来。

## MCP 工具

`memory_status`、`memory_recall`、`memory_search`、`memory_context`、`memory_brief`、`memory_add`、`memory_show`、`memory_distill`、`memory_gate`、`memory_adopt`、`memory_promote`、`memory_hook_status`、`memory_diagnostics`。

调用已删除的工具返回 unknown-tool 错误，不返回兼容结果。

## 旧数据导入

- 两步：预检报告将导入多少素材与会话、跳过多少 inbox 条目、`working.md` 是否存在；执行逐文件导入为**素材**，room 为 `legacy/<子目录>`。
- 旧 `<workspace>/memory/**` 原地只读保留，任何路径都不修改它。
- inbox 与 `working.md` 不导入。
- 重跑幂等，单文件失败不影响其余并进报告，报告落 `~/.loam/memory/import-reports/`。
- 导入结果是素材不是结论：要重新进入 agent 的上下文，得走一次 distill + adopt。

## 备份包

- 导出从库渲染成 Markdown 包（`manifest.json` + `evidence/*.md` + `knowledge/*.md`，YAML frontmatter + 正文）。
- 导入按同一格式解析回库，往返无损（逐字段）。
- 不含向量（导入时按当前模型重算）与上游卡片相关表。
- 全局单库没有自动备份，导出包是用户唯一的备份手段。

## 与 LLM Wiki 的关系

| 意图 | 用 |
|---|---|
| 给 agent 当前任务的上下文 | `memory_recall` |
| 在整理过的 wiki 上深问 | `llm-wiki query` |
| 把结论或素材变成 wiki 素材 | `memory_promote`（复制到 `raw/promoted/` 后可选 ingest） |
| 批量消化文档 | 放进 `raw/` 后走 LLM Wiki ingest |

`memory_promote`（转为 Wiki 素材）与 `memory_adopt`（采纳结论）是两件事，名字不要混。
