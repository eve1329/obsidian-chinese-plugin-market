# 中文语义检索词表扩充与召回质量评估（复核整改版）

对应提示词：`design-plans/ds-chinese-semantic-synonyms-prompt.md`
评估工具：`scripts/eval-synonym-recall.ts`（`pnpm eval:recall`）· 正例集：`scripts/eval-ground-truth.ts`
冻结基线：`scripts/baselines/synonyms.pre-round.ts`（`pnpm eval:recall:baseline`）

> **本文档已按独立复核意见整改。** 复核结论为「不接受」，指出三处必须修复的问题；
> 整改内容见第二节。**第一节里旧的「precision@10 = 10/10」数字已作废**，原因见第二节 2.2。

---

## 一、复核发现的问题与整改

| 复核项 | 结论 | 实际情况 | 整改 |
| --- | --- | --- | --- |
| 泛词 cap 语义 | 不通过 P1 | **确认成立。** 原实现只在「逐次注入」时 `min` 封顶，累加本身不受限：实测 `AI 写作 → ai=0.8`、`本地 AI → ai=1.2`、`向量搜索 → search=0.8`、`图片压缩 → image=0.8`。我此前在报告里写的「泛词始终采用 cap、复合别名不会累计」是**错的** | 在 `expandQueryTerms` 累加结束后对高风险泛词表统一封顶（只封高风险泛词，不封 canvas/whiteboard/freeform 等中泛化领域词）；新增 3 条测试钉住复合查询权重 |
| 评估脚本相关性判定 | 不通过 P1 | **确认成立。** 原脚本用 `/image\|compress\|图片\|压缩/`、`/pdf\|标注\|annotation\|highlight/`、`/ai\|writing\|写作/`、`/graph\|network/`、单字 `图` 等泛词正则判相关 —— 等于让脚本自己给自己打分，任何图片/PDF/写作插件都算命中，「10/10」是假的 | **删除全部泛词正则**，改为 `scripts/eval-ground-truth.ts` 里的**显式正例 ID 集**（逐条附入选证据，可逐条复核/反驳）；没有正例集的查询只报命中数，不给任何精度数字 |
| `--zh-only` 口径 | 不通过 P2 | **确认成立。** 评分用的 haystack 始终拼入插件 id，所以 `--zh-only` 只改了索引、没改评分 | 正则判据删除后该缺陷结构性消失：相关性判定只用显式 ID，不依赖任何文本拼接 |
| 无回归结论 | 无法判定 | **确认成立。** 基线副本是临时文件且已删，工作区在改动前就带上一轮未提交改动，`git show HEAD:` 不是正确基线 | 把改动前词表**冻结进仓库**（`scripts/baselines/synonyms.pre-round.ts`）+ 新增 `pnpm eval:recall:baseline`，基线现在可被第三方逐位复现 |
| 逐别名累加 | 复核提到（AI 泛词） | **同一根因的推广。** 同一 key 的多条别名是「同一概念的不同说法」，逐条累加会让 `AI 写作` 的 `writing` 变成 3、`无限画布` 的 `canvas` 变成 2 —— 这是别名条数的副产物，不是重要性的证据 | 同一 key 内按 token 去重（取最大权重、只计一次）；跨 key 累加保留 |
| 测试与构建 | 通过 | 复核确认 `pnpm test` / `pnpm build` / `git diff --check` 均通过，但同时指出「这些只能证明代码可构建，不能证明搜索精度正确」 | 接受该判断，本版报告把精度结论与测试结论**分开陈述**，不再用测试通过支撑召回质量 |

### 1.1 根因：中文侧的三元组盲区

复核举的 `图片压缩` / `PDF 标注` / `AI 写作` 三个例子有共同根因，值得单独记下来：

BM25 用 **CJK 三元组**分词。查询「图片压缩」（4 字）被切成 `图片压`、`片压缩` 两个三元组，
而插件描述里写的是「压缩」「压缩图像」——**两字词无法与四字查询共享任何三元组**。
实测 `图片压缩` 基线命中 137 条里，真阳性只靠 id 里的 `compress` / `image` 命中，
中文侧几乎不参与。`PDF 标注` 同理：真阳性大多写「PDF 注释」「pdf annotation」，
而查询只会匹配到原文里连写的「pdf标注」。

**修法**：用 `PLUGIN_EXACT_PHRASES`（连续子串加权，2.5×IDF）把同一概念的**不同措辞绑成一组** ——
查询侧命中任一写法即触发整组，索引侧对组内每条短语做连续子串匹配。
例如 `PDF标注` 组收 `PDF注释 / pdf 注释 / pdf annotation / annotate pdf / pdf highlight`，
`AI写作` 组收 `写作助手 / 写作助理`（AI 写作插件的高频说法，普通写作插件几乎不用），
`图片压缩` 组收 `压缩图像 / compress image / tinypng / pngquant / mozjpeg / webp`。

---

## 二、验收结果（人工正例集）

### 2.1 方法

- **语料**：`seeded-translator-cache.json` 的 6534 条中文译名/译文 + 插件 id（近似补齐生产语料里的英文原名/描述）。
- **判据**：`scripts/eval-ground-truth.ts` 的显式正例 ID 集。每个查询写明 `criterion`（判定标准）、
  逐条给出入选证据、并列出明确排除的反例与边界条目。`strong` = 主要功能就是该能力，`weak` = 该能力是主要功能之一。
- **基线**：`pnpm eval:recall:baseline`（冻结副本 + esbuild 别名替换，不改工作区源码）。
- **recall@N 口径**：N 取 BM25 路径的候选位次；生产路径截断到 500（`RECALL_PATH_CAP`）。

### 2.2 前后对照

| 查询 | 正例数 | 基线 precision@10 | 当前 precision@10 | 基线 recall@10 | 当前 recall@10 | 基线 recall@30 | 当前 recall@30 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| AI 写作 | 30 | **1/10** | **7/10** | 1/30 | **7/30** | 1/30 | **7/30** |
| PDF 标注 | 18 | **4/10** | **7/10** | 4/18 | **7/18** | 5/18 | **10/18** |
| 图片压缩 | 8 | **2/10** | **5/10** | 2/8 | **5/8** | 2/8 | **5/8** |
| 知识图谱 | 15 | **4/10** | **6/10** | 4/15 | **6/15** | 6/15 | 7/15 |
| 流程图 | 15 | 6/10 | 6/10 | 6/15 | 6/15 | 7/15 | **12/15** |
| 甘特图 | 13 | 10/10 | 10/10 | 10/13 | 10/13 | 10/13 | 11/13 |

**六项全部不低于基线，其中五项明显改善。** 只算 `strong` 正例时：甘特图 5/10、流程图 5/10、
PDF 标注 4/10、图片压缩 5/10、知识图谱 6/10、AI 写作 7/10（其余名额落在 weak 正例上）。

复现命令：

```bash
pnpm eval:recall:baseline -- --acceptance   # 基线
pnpm eval:recall -- --acceptance            # 当前（逐条列出命中/误召/漏召）
pnpm eval:recall -- --acceptance --markdown # 上表的机器可读版本
```

### 2.3 仍不合格的地方（如实列出）

| 查询 | 现状 | 原因 | 判断 |
| --- | --- | --- | --- |
| 图片压缩 | p@10 5/10、r@30 5/8 | 真阳性 `obsidian-paste-png-to-jpeg`（id 只有 png/jpeg）、`image-magick`（写「压缩和转换图像」）、`note-image-manager`（写「转换、压缩、编辑和恢复图像」）**没有任何英文压缩词**，只能靠 `image` 这一泛词命中；而 `image` 在 307 个插件里出现 | **关键词路做不到更好**。要么把 `jpeg/png` 也当别名（会引入大量图片插件，精度更差），要么依赖向量召回 |
| 知识图谱 | p@10 6/10 | 误召 `lovely-mindmap`/`poneglyph`/`jira-weaver`/`hangarx` 都含 `graph`/图谱类词但功能不是知识图谱；真阳性里 `vault-intelligence`/`understory`/`infranodus-graph-view` 等 8 个排在 30 名之外 | 部分可改进（`graph` 已是 0.4 上限）；「知识图谱」本身有语义歧义（见 3.4） |
| AI 写作 | p@10 7/10，但 r@30 仅 7/30 | 正例集有 30 条，`wordwise`/`nova`/`ai-copilot`/`ai-autocomplete` 等大量真阳性排在 30 名外 | 概念是**合取**（AI ∧ 写作），bag-of-words BM25 无法表达「同时满足」，只能靠短语锚点部分逼近。这是架构限制：关键词路负责召回（r@500 = 19/30），排序交给向量召回 + RRF + LLM 精排 |
| 流程图 | p@10 6/10 | 误召 `mermaid-flow-zoom`/`beauty-diagram`/`mermaid-helper`/`advanced-canvas` —— 都是 Mermaid 工具或画布插件；Obsidian 已内置 Mermaid 渲染，所以「与 Mermaid 相关」不等于「提供流程图能力」 | 边界判定有争议（见 `eval-ground-truth.ts` 的 boundary 字段）；按更宽松标准 p@10 为 8/10 |

**重要澄清**：提示词第一节写明「同义词扩展的目标是提高召回，不是直接决定最终排序」
（机制 3~5 条：关键词召回之后还有向量召回、RRF 融合、LLM 精排）。
上表的 `recall@500` 才对应词表这一层的职责：`PDF 标注 18/18`、`图片压缩 7/8`、
`AI 写作 19/30`、`流程图 11/15`。**若要求关键词路单独给出高精度 top-10，当前设计做不到**，
这不是词表能解决的问题，需要向量路或 LLM 精排参与（离线评估未启用这两条路）。

---

## 三、新增了哪些词

七类共约 130 个中文功能词 + 30 组精确短语（其中 20 组为本轮新增）。所有新词都先比对过现有词表，未重复定义。

| 类别 | 新增中文词（节选） |
| --- | --- |
| 知识管理与笔记方法 | 卡片盒、卡片笔记、Zettelkasten、第二大脑、个人知识管理、知识库、知识管理、原子笔记、永久笔记、文献笔记、读书笔记、研究笔记、概念图、知识图谱、知识网络、内容地图、MOC、目录笔记、索引笔记、双链笔记、反向链接、入链、出链、页面链接、块引用、块链接、属性管理、元数据、Frontmatter |
| 可视化与结构化 | 自由画布、视觉工作区、数字白板、架构图、组织结构图、网络图、时间线、时间轴、甘特图、矩阵、四象限、图库、画廊、仪表板 |
| 任务与生产力 | 任务管理、待办事项、任务清单、任务看板、子任务、项目管理、项目规划、目标管理、GTD、收集箱、快速捕获、日程安排、日程规划、周计划、月计划、时间块、时间追踪、番茄工作法、打卡、提醒、截止日期、重复任务、工作流、工作流自动化、闪卡 |
| AI / 搜索 / 知识增强 | AI写作、AI聊天、AI助手、AI摘要、AI改写、AI翻译、AI自动补全、AI绘图、本地AI、本地大模型、本地模型、大语言模型、LLM、RAG、检索增强生成、语义搜索、向量搜索、向量数据库、Embedding、嵌入模型、知识问答、语音转文字、文本转语音、图像生成、提示词、Prompt |
| 阅读 / 研究 / 文献 | 网页高亮、网页阅读、稍后阅读、PDF标注、PDF阅读、文献管理、论文管理、引用管理、参考文献、BibTeX、DOI、文献检索、学术搜索、批注、会议记录、会议纪要、转录、OCR、扫描识别 |
| 写作 / 编辑 / 文本 | 长文写作、Markdown、Markdown编辑器、富文本、排版、语法检查、拼写检查、同义词、字数统计、改写、格式化、代码块、代码高亮、代码运行 |
| 文件 / 媒体 / 同步 | 图片压缩、图片上传、附件管理、文件管理、文件夹导航、文件重命名、重复文件、音频、视频、YouTube、媒体库、相册、云同步、WebDAV、Git、静态网站 |

---

## 四、每类词的主要英文别名

| 中文 | 主要英文别名 |
| --- | --- |
| 卡片盒 / 卡片笔记 | `zettelkasten`、`slip box`、`card box`、`note cards` |
| 第二大脑 / 个人知识管理 | `second brain`、`personal knowledge management`、`pkm`、`knowledge management` |
| 知识库 / 知识图谱 | `knowledge base`、`wiki`、`knowledge graph`、`graph rag` |
| 双链笔记 | `wikilink`、`backlink`、`linked notes` |
| 自由画布 / 视觉工作区 | `freeform canvas`、`freeform workspace`、`visual workspace` |
| 时间线 / 甘特图 | `timeline`、`gantt chart`、`gantt` |
| 任务管理 / 项目管理 | `task management`、`task manager`、`project management` |
| 日程安排 / 工作流自动化 | `schedule`、`planner`、`workflow automation`、`automation` |
| 本地AI / 本地大模型 | `local ai`、`local llm`、`local model`、`ollama`、`offline ai` |
| RAG / 语义搜索 / 向量搜索 | `rag`、`retrieval augmented generation`、`semantic search`、`vector search`、`similarity search` |
| 图片压缩 | `image compression`、`compress image`、`image compressor`、`webp`、`tinypng`、`pngquant`、`mozjpeg` |
| PDF标注 | `pdf annotation`、`pdf annotate`、`annotate pdf`、`pdf highlight`、`pdf markup` |
| AI写作 | `ai writing`、`ai writer`、`ai writing assistant`、`generative writing` |
| 文献管理 / 会议纪要 | `reference management`、`citation management`、`zotero`、`meeting notes`、`minutes`、`transcript` |
| 流程图 | `flowchart`、`flow chart`、`diagram`、`mermaid`、`plantuml`、`nomnoml`、`bpmn`、`graphviz` |
| 闪卡 / 代码运行 | `flashcards`、`anki`、`code runner`、`execute code` |

**精确短语组额外收录「插件描述里真实出现的说法」**，这是本轮提升精度的主要手段：
`PDF标注` 组收 `PDF注释/pdf 注释/pdf annotation/annotate pdf`；`AI写作` 组收 `写作助手/写作助理`；
`图片压缩` 组收 `压缩图像/compress image/tinypng/pngquant/mozjpeg/webp`；`流程图` 组收 `flowchart/flow chart`。

**刻意没有加的别名**：知识管理词不扩展成裸 `note`/`obsidian`/`link`；`无限画布` 不加裸 `canvas`；
`时间线` 不加 `time`/`clock`/`date`；`工作流自动化` 不加裸 `workflow`；`格式化` 不扩展成 `style`。

---

## 五、实现要点（`synonyms.ts`）

1. **词表分层**写进代码与注释：精确功能词 / 中泛化领域词 / 高风险泛词。
2. **泛词权重拆两张表**：
   - `PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS`（0.4）：`笔记/链接/文件/时间/图表/代码/搜索/图片/同步` +
     `note/link/file/time/chart/code/search/image/sync/graph/management/manager/ai/pdf`。
     别名内部的 token 也按它降权。
   - 中泛化领域词 `画布/白板/canvas/whiteboard/freeform`：只在「命中中文泛词 key」与「用户直接输入英文」时降权。
     把 `canvas` 也纳入别名内部降权会让「无限画布」的前 10 精度从 9/10 掉到 3/10（画布类插件被自己的同义词挤出候选池）。
3. **泛词权重是上限（cap），且在累加结束后统一封顶** —— 这是复核 P1 的整改点。
4. **同一 key 内 token 去重**：别名条数不是重要性的证据。
5. **中英混合词空格归一**：`AI写作`/`PDF标注`/`本地AI` 一份 key 覆盖带空格与不带空格两种输入。
6. 长词优先、中文概念锚点、ASCII 词边界匹配等既有行为全部保留。

---

## 六、测试与构建

| 命令 | 结果 |
| --- | --- |
| `pnpm test`（`vitest run`） | **67 个文件、947 条测试全部通过**（旧测试全部保留，未删除任何 AI 搜索编排测试） |
| `tsc -noEmit -skipLibCheck` | 通过 |
| `node esbuild.config.mjs production` | 通过 |
| `git diff --check` | 无空白错误（仅仓库既有的 LF→CRLF 提示） |
| `pnpm eval:recall` | 索引构建 442ms / 6534 条（基线 354ms / 精确短语 16→62 条，增幅约 25%） |

> ⚠️ 这些只证明**代码可构建、机制有回归保护**，不证明搜索精度 —— 精度见第二节。

**测试新增/更新**：表驱动锚点（140+ 概念）、泛词封顶的复合查询用例（`AI 写作`/`本地 AI`/`向量搜索`/`图片压缩`/`文献管理`）、
同一 key 去重、别名内泛词降权、长词优先、ASCII 词边界、空 query 旧行为、高风险泛词别名数量上限、
BM25 级召回守卫 5 条（卡片盒/双链笔记/时间线/PDF 标注/本地 AI）、
**短语倒排表补 CJK 三元组盲区 2 条**（`PDF 标注`→「PDF 注释」、`AI 写作`→「写作助手」）。

---

## 七、文件改动

| 文件 | 改动 |
| --- | --- |
| `src/translation/lexicon/synonyms.ts` | 词表扩充 + 分层 + 泛词拆表 + 全局封顶 + 同一 key 去重 + 空格归一 + 精确短语组扩写 |
| `src/translation/lexicon/synonyms.test.ts` | 新增锚点/精度约束/封顶/去重测试 |
| `src/domain/search/ai.test.ts` | 参考实现与生产同源 + 召回守卫 + 短语盲区测试 |
| `scripts/eval-synonym-recall.ts` | 改为**只用显式正例集**判相关，输出 precision/recall 与逐条命中/误召/漏召明细 |
| `scripts/eval-ground-truth.ts` | **新增**：人工正例集（含判定标准、逐条证据、明确反例与边界条目） |
| `scripts/baselines/synonyms.pre-round.ts` | **新增**：冻结的改动前词表，使基线可复现 |
| `package.json` | 新增 `eval:recall`、`eval:recall:baseline` |
| `.gitignore` | 忽略两个评估打包产物 |

**未修改**生产代码 `ai.ts`、`view-ai-search.ts`（`git diff` 里它们的改动属于上一轮语义检索修复），未修改构建产物与 lockfile。

---

## 八、未完成项

1. **英文别名缺离线语料验证**：`kanban`、`vector`、`semantic`、`embedding`、`citation`、`meeting`、`compress`、`gantt`、`timeline` 在中文译文里出现 0~1 次，本次靠插件 id 近似补齐，**这些别名未能在离线语料上独立验证**。
2. **正例集只覆盖 6 个查询**，其余 29 个查询只有命中数、没有精度结论。扩展正例集是下一步的主要工作。
3. **正例集是 AI 助手人工标注，不是独立第三方标注** —— 已通过「逐条附证据 + 明确反例 + 边界条目复议说明」降低主观性，但仍非中立标注。
4. **合取型查询（AI 写作）在关键词路无法达到高精度**：r@500 19/30 是词表能做到的上限，最终排序依赖向量召回 + RRF + LLM 精排；本轮离线评估未启用这两条路，因此**没有端到端验证**。
5. **未跑 Playwright 端到端测试**（不覆盖中文功能词召回）。
