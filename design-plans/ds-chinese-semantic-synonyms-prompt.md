# DS 任务提示词：扩充中文语义检索词表并验证召回质量

你现在负责维护一个 Obsidian 中文插件市场项目中的 AI 语义检索词表。请直接检查并修改代码，不要只给建议。

## 项目目标

用户使用中文功能词搜索插件时，应该能够召回真正提供该功能的插件。例如：

- “无限画布”应该优先召回真正提供无限画布、自由画布、视觉工作区的插件；
- “流程图”应该优先召回 Mermaid、Flowchart、Diagram 相关插件；
- “卡片盒”应该能够召回 Zettelkasten、Slip-box、卡片盒笔记插件；
- “第二大脑”应该能够召回 PKM、Personal Knowledge Management、知识库类插件；
- “本地 AI”应该优先召回 Ollama、Local LLM、Embedding、RAG 等插件，而不是所有包含普通 AI 字样的插件。

请先完整阅读以下文件，理解现有逻辑后再编辑：

- `src/translation/lexicon/synonyms.ts`
- `src/translation/lexicon/synonyms.test.ts`
- `src/domain/search/ai.ts`
- `src/domain/search/bm25.ts`
- `src/domain/search/ai.test.ts`
- `src/ui/view/view-ai-search.ts`
- `src/ui/view/view-ai-search.test.ts`
- `seeded-translator-cache.json`
- `plugin-tags.json`

## 当前检索机制

1. `synonyms.ts` 中的 `expandQuery()` 将中文功能词扩展成英文别名；
2. BM25 使用 CJK 三元组分词；
3. AI 语义搜索现在已经会把中文译名、中文译文和英文原始名称/描述一起放入语义语料；
4. AI 模式后续还会经过向量召回、RRF 融合和 LLM 精排；
5. 所以同义词扩展的目标是提高召回，不是直接决定最终排序；
6. 当前已经存在这些领域词：

```text
无限画布 -> infinite canvas, infinite whiteboard, freeform canvas
画布 -> canvas, infinite canvas, whiteboard, freeform canvas
白板 -> whiteboard, canvas, infinite canvas, freeform
流程图 -> flowchart, flow chart, diagram, mermaid
思维导图 -> mind map, mindmap, markmap, map
笔记 -> note, notes, obsidian
同步 -> sync, syncing
看板 -> kanban
日历 -> calendar
番茄钟 -> pomodoro
任务 -> task, todo
数据库 -> database, db, sql
网页剪藏 -> clipper, web, save
间隔重复 -> spaced repetition, anki, srs
习惯追踪 -> habit tracker, tracker
```

## 一、补充高价值中文功能词

请优先补充下面这些词，但要先检查当前词表是否已经存在，避免重复定义。英文别名必须尽量是插件市场真实使用的术语，不要为了凑数量随便加近义词。

### 1. 知识管理和笔记方法

```text
卡片盒
Zettelkasten
第二大脑
个人知识管理
知识库
知识管理
原子笔记
永久笔记
文献笔记
读书笔记
研究笔记
概念图
知识图谱
知识网络
内容地图
MOC
目录笔记
索引笔记
双链
反向链接
入链
出链
页面链接
块引用
块链接
标签管理
属性管理
元数据
Frontmatter
```

建议方向：

```text
卡片盒 -> zettelkasten, slip box, card box, note cards
第二大脑 -> second brain, personal knowledge management, PKM
个人知识管理 -> personal knowledge management, PKM, knowledge management
知识库 -> knowledge base, knowledge management, wiki
原子笔记 -> atomic notes, atomic note
永久笔记 -> permanent notes, evergreen notes
概念图 -> concept map, concept mapping
知识网络 -> knowledge network, networked notes
内容地图 -> content map, content mapping
目录笔记 -> index note, MOC, table of contents
块链接 -> block link, block reference
属性管理 -> properties, metadata, frontmatter
```

不要把所有知识管理词都简单扩展成 `note`、`obsidian`、`link`，这些词太泛，会让候选数量暴涨。

### 2. 可视化和结构化

```text
无限画布
自由画布
视觉工作区
白板
数字白板
流程图
架构图
概念图
思维导图
组织结构图
网络图
关系图
时间线
时间轴
甘特图
看板
矩阵
四象限
表格
数据库
图库
画廊
仪表板
```

建议方向：

```text
自由画布 -> freeform canvas, freeform workspace
视觉工作区 -> visual workspace, visual board
数字白板 -> digital whiteboard, whiteboard
架构图 -> architecture diagram, system diagram
组织结构图 -> org chart, organizational chart
网络图 -> network graph, network diagram
时间轴 -> timeline, time axis
甘特图 -> gantt chart, gantt
四象限 -> quadrants, four quadrants, matrix
仪表板 -> dashboard, control panel
图库 -> gallery, gallery view
```

精度要求：

- `无限画布` 不要加入裸 `canvas`；
- `自由画布` 不要只扩展成普通 `canvas`；
- `流程图` 可以扩展 `flowchart`、`diagram`、`mermaid`；
- `时间线` 不要加入过多的 `time`、`clock`、`date` 等泛词；
- `知识图谱` 不要只扩展成裸 `graph`，应优先使用 `knowledge graph`、`graph RAG`、`knowledge network`；
- 普通 `画布` 可以保留 `canvas`，但不要让它污染精确的“无限画布”。

### 3. 任务、生产力和个人管理

```text
任务管理
待办事项
任务清单
任务看板
子任务
项目管理
项目规划
目标管理
GTD
收集箱
快速捕获
日程安排
日程规划
周计划
月计划
时间块
时间追踪
番茄工作法
习惯追踪
打卡
提醒
截止日期
重复任务
工作流
工作流自动化
```

建议方向：

```text
任务管理 -> task management, task manager, todo manager
待办事项 -> todo, to-do, checklist
任务清单 -> task list, todo list, checklist
子任务 -> subtasks, subtask
项目管理 -> project management, project manager
项目规划 -> project planning, project planner
目标管理 -> goal management, goals, OKR
收集箱 -> inbox, capture inbox
快速捕获 -> quick capture, quick note, capture
日程安排 -> schedule, scheduling, planner
日程规划 -> daily planner, schedule planner
时间块 -> time blocking, time block
时间追踪 -> time tracking, time tracker
番茄工作法 -> pomodoro, pomodoro timer
打卡 -> habit tracker, check-in, daily check-in
重复任务 -> recurring tasks, repeating tasks
工作流自动化 -> workflow automation, automation
```

注意：

- `todo`、`task`、`checklist` 可以用于一般任务词；
- 不要给所有生产力词都追加 `note` 或 `obsidian`；
- `工作流自动化` 不要扩展成过宽的 `workflow`、`flow`，避免混入流程图插件；
- `日程安排` 和 `时间线` 必须区分，不能互相无限扩展。

### 4. AI、搜索和知识增强

```text
AI
人工智能
AI 写作
AI 聊天
AI 助手
本地 AI
本地大模型
本地模型
大语言模型
LLM
RAG
检索增强生成
语义搜索
向量搜索
向量数据库
Embedding
嵌入模型
知识问答
AI 摘要
AI 改写
AI 翻译
AI 自动补全
语音转文字
文本转语音
图像生成
AI 绘图
提示词
Prompt
```

建议方向：

```text
AI -> ai, artificial intelligence, gpt, llm
人工智能 -> artificial intelligence, ai, llm
AI 写作 -> ai writing, writing assistant, generative writing
AI 聊天 -> ai chat, chatbot, chat assistant
AI 助手 -> ai assistant, copilot, assistant
本地 AI -> local ai, local llm, ollama, offline ai
本地大模型 -> local llm, local model, ollama
大语言模型 -> large language model, llm, generative ai
RAG -> rag, retrieval augmented generation, retrieval-augmented generation
检索增强生成 -> retrieval augmented generation, RAG
语义搜索 -> semantic search, semantic retrieval
向量搜索 -> vector search, vector retrieval, similarity search
向量数据库 -> vector database, vector store, vector db
Embedding -> embedding, embeddings, vector embedding
知识问答 -> knowledge QA, question answering, RAG
AI 摘要 -> ai summary, summarization, summarize
AI 改写 -> ai rewrite, rewriting, paraphrase
AI 自动补全 -> autocomplete, ai completion, text completion
文本转语音 -> text to speech, TTS, speech synthesis
图像生成 -> image generation, ai image, text to image
提示词 -> prompt, prompting, prompt engineering
```

精度要求：

- `AI` 本身是高频泛词，不要单独依赖它判断结果；
- `本地 AI` 必须优先使用 `local ai`、`local llm`、`ollama`、`offline ai`；
- `RAG` 不要只扩展成 `AI`；
- `语义搜索` 不要只扩展成 `search`；
- `Embedding` 不要扩展成大量弱相关泛词；
- `AI 写作` 不要和普通“写作”完全等价。

### 5. 阅读、研究和文献

```text
网页剪藏
网页高亮
网页阅读
阅读模式
稍后阅读
PDF 标注
PDF 阅读
文献管理
论文管理
引用管理
参考文献
BibTeX
DOI
文献检索
学术搜索
读书笔记
摘录
高亮
批注
会议记录
会议纪要
转录
OCR
扫描识别
```

建议方向：

```text
网页高亮 -> web highlighting, web annotations, web clipper
网页阅读 -> web reader, browser reader, reading mode
稍后阅读 -> read later, read-it-later, read later list
PDF 标注 -> PDF annotation, PDF highlights, PDF markup
PDF 阅读 -> PDF reader, PDF viewer
文献管理 -> reference management, citation management, bibliography
论文管理 -> paper management, academic papers
引用管理 -> citation management, citations, references
参考文献 -> references, bibliography, citations
文献检索 -> literature search, academic search, research search
摘录 -> highlights, excerpts, quotes
批注 -> annotations, annotation, markup
会议纪要 -> meeting notes, meeting minutes
转录 -> transcription, transcript
OCR -> OCR, optical character recognition
扫描识别 -> OCR, document scanning, text recognition
```

注意：

- `PDF 标注` 不要同时扩展普通 `highlight`、`badge`、`callout` 等明显泛词；
- `会议纪要` 和普通 `笔记` 不要完全等价；
- `文献管理` 应优先命中 Zotero、BibTeX、citation、reference 类插件。

### 6. 写作、编辑和文本工具

```text
写作
长文写作
Markdown
Markdown 编辑器
富文本
排版
语法检查
拼写检查
校对
同义词
字数统计
摘要
改写
翻译
格式化
目录
大纲
折叠
代码块
代码高亮
```

建议方向：

```text
长文写作 -> long-form writing, manuscript, writing
Markdown 编辑器 -> markdown editor, markdown
富文本 -> rich text, rich text editor
排版 -> typography, typesetting, formatting
语法检查 -> grammar checker, grammar, proofreading
拼写检查 -> spell checker, spelling
校对 -> proofreading, grammar checker
字数统计 -> word count, writing statistics
摘要 -> summary, summarization
改写 -> rewrite, rewriting, paraphrase
格式化 -> formatter, formatting, pretty printer
大纲 -> outline, table of contents, TOC
代码高亮 -> syntax highlighting, code highlight
```

注意：

- `写作` 和 `AI 写作` 要保持区分；
- `摘要` 不要自动等同于 AI；
- `目录`、`大纲`、`TOC` 可以互相映射，但不要追加 `folder`；
- `格式化` 不要直接扩展为所有 `style`。

### 7. 文件、媒体和同步

```text
图片压缩
图片上传
图床
附件管理
文件管理
文件夹导航
文件重命名
重复文件
音频
视频
YouTube
媒体库
相册
导出
导入
备份
同步
云同步
WebDAV
Git
版本控制
发布
静态网站
```

建议方向：

```text
图片压缩 -> image compression, image optimizer, pngquant, mozjpeg
图片上传 -> image upload, image uploader
图床 -> image hosting, image host, image CDN
附件管理 -> attachment management, attachments
文件管理 -> file management, file manager
文件夹导航 -> file explorer, folder navigation, file navigation
文件重命名 -> file renaming, rename
重复文件 -> duplicate files, duplicate finder
媒体库 -> media library, media manager
相册 -> gallery, photo gallery, album
云同步 -> cloud sync, cloud synchronization
版本控制 -> version control, git
静态网站 -> static site, static website, publishing
```

注意：

- `文件`、`附件`、`图片`、`同步` 都是泛词，扩展要克制；
- 不要让“图片上传”召回所有图片查看器；
- 不要让“同步”召回所有包含 sync 的插件后完全失去排序区分；
- `Git`、`版本控制`、`备份`应该保持不同语义层次。

## 二、改进词表实现

请检查现有 `expandQuery()`，确保以下行为继续成立：

1. 中文长词优先匹配。例如“无限画布”命中后，不应该再重复命中“画布”。
2. 精确短语不得被泛词稀释。“无限画布”不要因为加入普通 `canvas`，让普通 Canvas 工具大规模挤压真正的无限画布插件。
3. 对自然语言查询保留中文概念锚点。查询“我想找一个无限画布相关的插件”的扩展结果中应该仍然包含“无限画布”、`infinite canvas`、`infinite whiteboard`、`freeform canvas`。
4. 对英文原词不要误匹配。`AI` 不能因为子串匹配而误命中 `email`、`detail` 等普通词。
5. 空 query、未命中的 query 和纯英文 query 的旧行为不能被破坏。
6. 不要把所有 alias 去重成一个巨大的全局词库。每个中文概念的扩展必须尽量保持局部、可解释。

## 三、建立“精确词”和“泛词”的分层

请在实现或注释中明确区分以下三类词。

### 精确功能词

适合扩展多个强相关英文短语：

```text
无限画布
流程图
思维导图
甘特图
卡片盒
间隔重复
习惯追踪
网页剪藏
会议纪要
图片压缩
文献管理
向量搜索
```

### 中等泛化词

只扩展少量稳定别名：

```text
白板
画布
时间线
知识图谱
任务管理
项目管理
数据库
AI 助手
```

### 高风险泛词

必须克制，不要增加大量别名：

```text
笔记
链接
文件
时间
图表
代码
AI
搜索
图片
同步
```

对高风险泛词，宁可少召回，也不要把候选池扩大到几千条。

## 四、评估要求

请不要只检查 `expandQuery()` 的字符串结果。必须使用项目现有 BM25 逻辑和 `seeded-translator-cache.json` 做实际评估。

至少测试这些查询：

```text
无限画布
我想找一个无限画布相关的插件
画布
白板
流程图
思维导图
卡片盒
第二大脑
个人知识管理
知识库
甘特图
时间线
任务管理
项目管理
日程安排
工作流自动化
网页剪藏
PDF 标注
文献管理
会议纪要
本地 AI
RAG
语义搜索
向量搜索
闪卡
间隔重复
习惯追踪
图片压缩
代码运行
数据库
```

对每个查询输出：

```text
查询词：
扩展后的 query：
BM25 命中数：
前 10 个插件：
明显无关结果：
是否需要收窄 alias：
```

重点检查：

- `卡片盒` 不再是 0 命中；
- `第二大脑` 能命中 PKM、知识库、知识管理插件；
- `流程图` 前列应是 Mermaid、Flowchart、Diagram 类插件；
- `无限画布` 前列应保留真正的无限画布插件；
- `时间线` 不应被大量普通时间、日期、时钟插件污染；
- `双链笔记`、`读书笔记` 不应因为 `note`、`link` 等泛词扩展而召回几千条；
- `PDF 标注` 不应大量出现 badge、callout 等非 PDF 标注插件；
- `本地 AI` 不应被普通 AI 写作插件完全占满。

## 五、测试要求

请补充或更新测试，至少包括：

1. 每个新增精确词都能扩展出预期英文短语；
2. 长词优先规则继续成立；
3. `无限画布` 不会重复加入普通 `canvas`；
4. `卡片盒`、`第二大脑`、`个人知识管理`、`RAG`、`语义搜索` 有对应英文锚点；
5. 精确词不会因为泛词扩展导致结果数量异常爆炸；
6. 现有旧测试全部保留，不能删除原有 AI 搜索编排测试；
7. 如果发现某些词在当前中文翻译缓存中没有足够数据，请把它们标记为“需要补翻译语料”，不要伪造测试通过。

## 六、文件修改范围

优先只修改：

```text
src/translation/lexicon/synonyms.ts
src/translation/lexicon/synonyms.test.ts
src/domain/search/ai.test.ts
```

如果确实需要修改其他生产代码，必须说明原因。不要顺便重构无关模块，不要修改生产构建产物，不要修改 lockfile。

## 七、验证命令

完成后执行：

```bash
pnpm test
pnpm build
git diff --check
```

如果依赖链接缺失，可以先使用项目锁定版本离线恢复：

```bash
corepack pnpm install --offline --ignore-scripts --frozen-lockfile
```

## 八、最终汇报要求

最终请用中文汇报：

1. 新增了哪些词；
2. 每类词的主要英文别名；
3. 哪些词的召回明显改善；
4. 哪些词仍然存在数据不足或语义歧义；
5. 测试和构建结果；
6. 是否有任何未完成项。

不要把“新增了很多英文同义词”当成完成标准。完成标准是：中文功能词能够召回正确插件，同时不因为泛词扩展让结果严重失真。
