/**
 * 插件专属同义词表：中文口语/术语 → 英文别名。
 *
 * 动机：插件市场插件名大多是英文（Notion、Kanban、Mind Map…），中文用户常
 * 用中文口语搜索（"思维导图""笔记""同步"）。把 query 里的中文词扩展出英文
 * 别名，能让关键词路（BM25）命中英文插件名，提升"用中文搜英文名"的召回。
 *
 * 借鉴 vault-curate 的 expandQuery 思路（但 vault 里未接线，这里我们接入
 * BM25 query 管线）。只扩展 query，不改索引。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 词表分层（新增词必须归入其中一层，避免「为了凑数量加近义词」）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1) 精确功能词 —— 语义边界清晰、插件名/描述里有稳定术语对应。
 *    可以放心给多个强相关英文短语（含长短语），并进入 PLUGIN_EXACT_PHRASES
 *    走连续子串加权：
 *    无限画布 / 流程图 / 思维导图 / 甘特图 / 卡片盒 / 第二大脑 / 间隔重复 /
 *    习惯追踪 / 网页剪藏 / 会议纪要 / 图片压缩 / 文献管理 / 向量搜索 /
 *    语义搜索 / 双链笔记 / PDF标注 / 本地AI …
 *
 * 2) 中等泛化词 —— 有明确含义但覆盖范围偏大，只扩展少量稳定别名，
 *    不进入精确短语表：
 *    白板 / 画布 / 时间线 / 知识图谱 / 任务管理 / 项目管理 / 数据库 / AI 助手 …
 *
 * 3) 高风险泛词 —— 命中量大、含义漂移严重，**不增加别名**，并在
 *    PLUGIN_GENERIC_WORD_WEIGHTS 里降权；对它们的诉求是「宁可少召回，
 *    也不要把候选池扩大到几千条」：
 *    笔记 / 链接 / 文件 / 时间 / 图表 / 代码 / AI / 搜索 / 图片 / 同步
 *
 * 长词优先：`expandQuery` / `expandQueryTerms` 按 key 长度降序匹配，
 * 命中「无限画布」后不会再命中其子词「画布」，因此精确概念不会被泛词稀释；
 * 「双链笔记 / 读书笔记 / 卡片笔记 / 文献笔记 / 时间线 / 云同步 / 图片压缩」
 * 这些复合词同理，它们同时也是「笔记 / 时间 / 同步 / 图片」这些泛词的抑制器。
 */

/** 常见插件领域同义词（中文词 → 英文别名列表）。key 为中文词，value 为别名。 */
export const PLUGIN_SYNONYMS: Record<string, string[]> = {
	// ───────── 知识管理与笔记方法 ─────────
	"卡片盒": ["zettelkasten", "slip box", "card box", "note cards"],
	"卡片笔记": ["zettelkasten", "slip box", "smart notes"],
	"zettelkasten": ["zettelkasten", "slip box", "atomic notes"],
	"第二大脑": ["second brain", "personal knowledge management", "pkm"],
	"个人知识管理": ["personal knowledge management", "pkm", "knowledge management"],
	"知识库": ["knowledge base", "knowledge management", "wiki"],
	"知识管理": ["knowledge management", "pkm"],
	"原子笔记": ["atomic notes", "atomic note"],
	"永久笔记": ["permanent notes", "evergreen notes"],
	"文献笔记": ["literature notes", "reference notes"],
	"读书笔记": ["reading notes", "book notes"],
	"研究笔记": ["research notes"],
	"概念图": ["concept map", "concept mapping"],
	"知识图谱": ["knowledge graph", "graph rag", "knowledge network"],
	"知识网络": ["knowledge network", "networked notes"],
	"内容地图": ["content map", "content mapping", "map of content"],
	"moc": ["moc", "map of content", "index note"],
	"目录笔记": ["index note", "moc", "table of contents"],
	"索引笔记": ["index note", "moc"],
	"双链": ["wikilink", "backlink", "bidirectional link"],
	"双链笔记": ["wikilink", "backlink", "linked notes"],
	"反向链接": ["backlink", "backlinks", "reverse link"],
	"入链": ["backlink", "incoming link"],
	"出链": ["outgoing link", "outlink"],
	"页面链接": ["page link", "internal link"],
	"块引用": ["block reference", "block quote", "blockquote"],
	"块链接": ["block link", "block reference"],
	"标签": ["tag", "tags"],
	"标签管理": ["tag management", "tag pane", "tagging"],
	"属性管理": ["properties", "metadata", "frontmatter"],
	"元数据": ["metadata", "frontmatter", "properties"],
	"frontmatter": ["frontmatter", "yaml", "properties"],
	"笔记": ["note", "notes", "obsidian"],

	// ───────── 可视化与结构化 ─────────
	"无限画布": ["infinite canvas", "infinite whiteboard", "freeform canvas"],
	"自由画布": ["freeform canvas", "freeform workspace"],
	"视觉工作区": ["visual workspace", "visual board", "infinite canvas"],
	"画布": ["canvas", "infinite canvas", "whiteboard", "freeform canvas"],
	"白板": ["whiteboard", "canvas", "infinite canvas", "freeform"],
	"数字白板": ["digital whiteboard", "whiteboard", "online whiteboard"],
	"流程图": ["flowchart", "flow chart", "diagram", "mermaid", "plantuml", "nomnoml", "bpmn", "graphviz"],
	"思维导图": ["mind map", "mindmap", "markmap", "map"],
	"架构图": ["architecture diagram", "system diagram"],
	"组织结构图": ["org chart", "organizational chart"],
	"网络图": ["network graph", "network diagram"],
	"关系图": ["graph", "graph view"],
	"图谱": ["graph", "graph view"],
	"时间线": ["timeline", "timeline view"],
	"时间轴": ["timeline", "time axis"],
	"甘特图": ["gantt chart", "gantt"],
	"看板": ["kanban", "kanban board"],
	"矩阵": ["matrix", "matrix view"],
	"四象限": ["quadrants", "four quadrants", "eisenhower matrix"],
	"表格": ["table", "database", "spreadsheet"],
	"数据库": ["database", "db", "sql"],
	"图库": ["gallery", "gallery view", "image gallery"],
	"画廊": ["gallery", "gallery view"],
	"仪表板": ["dashboard", "control panel"],
	"图表": ["chart", "graph", "plot"],
	"图表分析": ["chart", "charting"],
	"数据分析": ["data", "analysis", "analytics"],
	"分析": ["analysis", "analytics", "stats"],
	"统计": ["statistics", "stats", "count"],

	// ───────── 任务、生产力与个人管理 ─────────
	"任务": ["task", "todo"],
	"任务管理": ["task management", "task manager", "todo manager"],
	"待办": ["todo", "task", "checklist"],
	"待办事项": ["todo", "to-do", "checklist"],
	"任务清单": ["task list", "todo list", "checklist"],
	"任务看板": ["kanban board", "task board", "kanban"],
	"子任务": ["subtasks", "subtask"],
	"清单": ["list", "checklist", "todo"],
	"项目管理": ["project management", "project manager"],
	"项目规划": ["project planning", "project planner"],
	"目标管理": ["goal management", "goals", "okr"],
	"gtd": ["gtd", "getting things done"],
	"收集箱": ["inbox", "capture inbox"],
	"快速捕获": ["quick capture", "quick note", "capture"],
	"日程安排": ["schedule", "scheduling", "planner"],
	"日程规划": ["daily planner", "schedule planner"],
	"周计划": ["weekly planner", "weekly review"],
	"月计划": ["monthly planner", "monthly plan"],
	"时间块": ["time blocking", "time block"],
	"时间追踪": ["time tracking", "time tracker"],
	"日历": ["calendar"],
	"日记": ["daily", "journal", "diary"],
	"周记": ["weekly", "journal"],
	"番茄": ["pomodoro", "tomato", "focus"],
	"番茄钟": ["pomodoro"],
	"番茄工作法": ["pomodoro", "pomodoro timer"],
	"习惯": ["habit", "tracker"],
	"习惯追踪": ["habit tracker", "tracker"],
	"打卡": ["habit tracker", "check-in", "daily check-in"],
	"提醒": ["reminder", "reminders", "notification"],
	"截止日期": ["due date", "deadline"],
	"重复任务": ["recurring tasks", "repeating tasks", "recurrence"],
	"工作流": ["workflow", "workflows"],
	"工作流自动化": ["workflow automation", "automation"],
	"模板": ["template", "templater"],
	"学习": ["learning", "study", "spaced repetition"],
	"间隔重复": ["spaced repetition", "anki", "srs"],
	"闪卡": ["flashcards", "flashcard", "anki"],
	"记忆": ["memory", "spaced repetition", "anki"],

	// ───────── AI、搜索与知识增强 ─────────
	// 注意：AI 是 ASCII key，同时又是 PLUGIN_GENERIC_WORD_WEIGHTS 的候选；
	// 这里刻意不把它加入权重表 —— ASCII 泛词会在「原 query 预降权」与
	// 「命中 key 后再降权」两处各乘一次，导致原词权重被平方衰减，
	// 与别名权重不一致。AI 的收窄改由「本地AI / AI写作 / AI助手」等长 key 抑制实现。
	"AI": ["ai", "artificial intelligence", "gpt", "llm", "openai"],
	"人工智能": ["artificial intelligence", "ai", "llm"],
	"AI写作": ["ai writing", "ai writer", "ai writing assistant", "generative writing"],
	"AI聊天": ["ai chat", "chatbot", "chat assistant"],
	"AI助手": ["ai assistant", "copilot", "assistant"],
	"AI摘要": ["ai summary", "summarization", "summarize"],
	"AI改写": ["ai rewrite", "rewriting", "paraphrase"],
	"AI翻译": ["ai translation", "ai translate", "translate"],
	"AI自动补全": ["autocomplete", "ai completion", "text completion"],
	"AI绘图": ["ai drawing", "text to image", "image generation"],
	"本地AI": ["local ai", "local llm", "ollama", "offline ai"],
	"本地大模型": ["local llm", "local model", "ollama"],
	"本地模型": ["local model", "local llm", "ollama"],
	"大语言模型": ["large language model", "llm", "generative ai"],
	"llm": ["llm", "large language model"],
	"rag": ["rag", "retrieval augmented generation", "retrieval-augmented generation"],
	"检索增强生成": ["retrieval augmented generation", "rag"],
	"语义搜索": ["semantic search", "semantic retrieval"],
	"向量搜索": ["vector search", "vector retrieval", "similarity search"],
	"向量数据库": ["vector database", "vector store", "vector db"],
	"embedding": ["embedding", "embeddings", "vector embedding"],
	"嵌入模型": ["embedding model", "embeddings"],
	"知识问答": ["knowledge qa", "question answering", "rag"],
	"语音转文字": ["speech to text", "transcription", "whisper"],
	"文本转语音": ["text to speech", "tts", "speech synthesis"],
	"图像生成": ["image generation", "text to image", "stable diffusion"],
	"提示词": ["prompt", "prompting", "prompt engineering"],
	"prompt": ["prompt", "prompting", "prompt engineering"],
	"搜索": ["search", "find"],

	// ───────── 阅读、研究与文献 ─────────
	"网页": ["web", "page", "url"],
	"网页剪藏": ["web clipper", "clipper", "web clip"],
	"剪藏": ["clipper", "web clipper"],
	"网页高亮": ["web highlighting", "web annotations", "highlighter"],
	"网页阅读": ["web reader", "browser reader", "reading mode"],
	"阅读模式": ["reading mode", "reading view", "reader"],
	"稍后阅读": ["read later", "read-it-later", "reading list"],
	"PDF标注": ["pdf annotation", "pdf annotate", "annotate pdf", "pdf highlight", "pdf markup"],
	"PDF阅读": ["pdf reader", "pdf viewer"],
	"文献": ["citation", "reference", "bibtex"],
	"文献管理": ["reference management", "citation management", "bibliography", "zotero"],
	"论文管理": ["paper management", "academic papers"],
	"引用": ["citation", "quote", "bibtex"],
	"引用管理": ["citation management", "citations", "references"],
	"参考文献": ["references", "bibliography", "citations"],
	"bibtex": ["bibtex", "bibliography", "citation"],
	"doi": ["doi", "crossref", "citation"],
	"文献检索": ["literature search", "academic search", "research search"],
	"学术搜索": ["academic search", "scholar", "google scholar"],
	"摘录": ["excerpt", "excerpts", "quote", "quotes"],
	"高亮": ["highlight", "highlights", "mark"],
	"标注": ["annotation", "annotate", "markup"],
	"批注": ["annotations", "annotation", "markup"],
	"会议记录": ["meeting notes", "meeting minutes"],
	"会议纪要": ["meeting notes", "meeting minutes", "transcript"],
	"转录": ["transcription", "transcript", "speech to text"],
	"ocr": ["ocr", "optical character recognition"],
	"扫描识别": ["ocr", "document scanning", "text recognition"],
	"朗读": ["tts", "read", "speech"],
	"录音": ["record", "recording", "audio"],
	"语音": ["speech", "tts", "audio"],

	// ───────── 写作、编辑与文本工具 ─────────
	"写作": ["writing", "writer"],
	"长文写作": ["long-form writing", "manuscript", "writing"],
	"markdown": ["markdown"],
	"Markdown编辑器": ["markdown editor", "markdown"],
	"富文本": ["rich text", "wysiwyg"],
	"排版": ["typography", "typesetting", "formatting"],
	"语法检查": ["grammar checker", "grammar check", "proofreading"],
	"拼写检查": ["spell checker", "spelling check"],
	"拼写": ["spell", "spelling", "grammar"],
	"语法": ["grammar", "spell"],
	"校对": ["proofreading", "proofread", "grammar check"],
	"同义词": ["thesaurus", "synonyms"],
	"字数": ["word count", "count", "stats"],
	"字数统计": ["word count", "character count"],
	"摘要": ["summary", "summarize"],
	"改写": ["rewrite", "rewriting", "paraphrase"],
	"翻译": ["translate", "translation"],
	"格式化": ["formatter", "formatting", "prettier"],
	"大纲": ["outline", "toc", "heading"],
	"目录": ["toc", "outline", "table of contents"],
	"标题": ["heading", "header", "h1"],
	"分割线": ["divider", "hr", "separator"],
	"折叠": ["collapse", "fold"],
	"代码块": ["code block", "codeblock"],
	"代码高亮": ["syntax highlighting", "code highlight", "syntax highlight"],
	"语法高亮": ["syntax highlighting", "syntax highlight"],
	"代码": ["code", "codeblock", "coder"],
	"代码运行": ["code runner", "run code", "execute code"],
	"编辑器": ["editor", "edit"],
	"预览": ["preview", "view"],
	"预览窗口": ["hover", "popup", "preview"],
	"编辑模式": ["source", "edit"],
	"悬浮": ["hover", "popup", "preview"],
	"滚动": ["scroll", "scrollbar"],
	"图标": ["icon", "emoji"],
	"表情": ["emoji", "icon"],
	"角标": ["badge", "count"],
	"进度": ["progress", "bar"],
	"样式": ["style", "css", "theme"],
	"主题": ["theme", "css", "style"],
	"字体": ["font", "type"],
	"快捷键": ["hotkey", "shortcut", "keyboard"],
	"命令": ["command", "palette", "cmd"],
	"中文": ["chinese", "zh", "cn"],
	"英文": ["english", "en"],

	// ───────── 文件、媒体与同步 ─────────
	"图片压缩": ["image compression", "compress image", "image compressor", "webp", "tinypng", "pngquant", "mozjpeg"],
	"图片上传": ["image upload", "image uploader", "image hosting"],
	"图床": ["image hosting", "image host", "picgo"],
	"图片粘贴": ["image paste"],
	"图片": ["image", "img", "attachment"],
	"附件管理": ["attachment management", "attachments"],
	"附件": ["attachment", "file"],
	"文件管理": ["file management", "file manager"],
	"文件": ["file", "attachment"],
	"文件夹": ["folder", "directory"],
	"文件夹导航": ["file explorer", "folder navigation", "file navigation"],
	"文件重命名": ["file renaming", "rename"],
	"重复文件": ["duplicate files", "duplicate finder", "deduplicate"],
	"音频": ["audio", "mp3"],
	"视频": ["video", "videos"],
	"youtube": ["youtube", "video embed"],
	"媒体库": ["media library", "media manager"],
	"相册": ["gallery", "photo gallery", "album"],
	"导出": ["export", "exporting"],
	"导入": ["import", "importing"],
	"备份": ["backup", "backups"],
	"恢复": ["recover", "restore", "undo"],
	"撤销": ["undo", "history"],
	"历史": ["history", "revision", "undo"],
	"同步": ["sync", "syncing"],
	"云同步": ["cloud sync", "cloud synchronization", "cloud storage"],
	"webdav": ["webdav"],
	"git": ["git", "version control"],
	"版本": ["version", "git"],
	"版本控制": ["git", "version control"],
	"发布": ["publish", "publishing"],
	"分享": ["share", "publish"],
	"静态网站": ["static site", "static website", "publishing"],
	"浏览器": ["browser", "web"],
	"链接": ["link", "wikilink", "url"],
	"导航": ["navigation", "nav", "breadcrumb"],
	"书签": ["bookmark", "favorite"],
	"收藏": ["favorite", "bookmark", "star"],
	"剪贴板": ["clipboard", "paste"],
	"复制": ["copy", "clipboard"],
	"剪切": ["cut", "clipboard"],
	"粘贴": ["paste", "clipboard"],
	"密码": ["password", "encrypt", "lock"],
	"加密": ["encrypt", "encryption", "password"],
	"隐私": ["privacy", "encrypt"],

	// ───────── 其他领域 ─────────
	"时间": ["time", "clock", "timer"],
	"日期": ["date", "day"],
	"时区": ["timezone", "time"],
	"年龄": ["age", "birthday"],
	"名字": ["name", "naming"],
	"命名": ["naming", "name"],
	"邮箱": ["email", "mail"],
	"邮件": ["email", "mail"],
	"微信": ["wechat", "weixin"],
	"健身": ["fitness", "workout", "habit"],
	"运动": ["fitness", "exercise", "sport"],
	"健康": ["health", "fitness"],
	"冥想": ["meditation", "mindful"],
	"理财": ["finance", "money", "expense"],
	"记账": ["expense", "finance", "money"],
	"预算": ["budget", "finance"],
	"食谱": ["recipe", "food"],
	"美食": ["recipe", "food", "cooking"],
	"菜谱": ["recipe", "cooking"],
	"旅行": ["travel", "trip"],
	"行程": ["itinerary", "trip", "travel"],
	"天气": ["weather", "forecast"],
	"编程": ["code", "developer"],
	"开发": ["developer", "dev", "code"],
	"思维": ["thinking", "thought"],
};

/**
 * 需要作为一个概念处理的短语。
 *
 * `PLUGIN_SYNONYMS` 保持原有的 string[] 形状，避免已有调用方失效；这里单独
 * 存放短语元数据，让 BM25 可以提高「无限画布」这类长词的权重，而不必把所有
 * 同义词都改成对象。值中包含中文原词和应优先命中的英文短语。
 *
 * 为什么值里同时放中文与英文：中文查询（"卡片盒"）能借此把英文术语
 * （zettelkasten）也拉进连续子串加权；反之英文查询（"zettelkasten"）也会
 * 命中同一组，得到同样的中文锚点。索引侧会为每个变体建短语倒排表，
 * 因此这张表要克制 —— 只收「精确功能词」，不放泛词。
 */
export const PLUGIN_EXACT_PHRASES: Record<string, string[]> = {
	// 知识管理
	"卡片盒": ["卡片盒", "zettelkasten", "slip box"],
	"第二大脑": ["第二大脑", "second brain", "personal knowledge management"],
	"个人知识管理": ["个人知识管理", "personal knowledge management", "pkm"],
	"知识图谱": ["知识图谱", "knowledge graph"],
	"双链笔记": ["双链笔记", "wikilink", "backlink"],
	// 可视化
	"无限画布": ["无限画布", "infinite canvas", "infinite whiteboard", "freeform canvas"],
	"自由画布": ["自由画布", "freeform canvas"],
	// 「流程图」按三元组分词只能命中原文里连写的「流程图」；真阳性插件大量写的是
	// 「flowchart」「flow chart」，短语组让两种写法互相锚定。
	"流程图": ["流程图", "flowchart", "flow chart", "流程图表"],
	"甘特图": ["甘特图", "gantt chart"],
	"时间线": ["时间线", "timeline"],
	// 生产力
	"任务管理": ["任务管理", "task management"],
	"工作流自动化": ["工作流自动化", "workflow automation"],
	"间隔重复": ["间隔重复", "spaced repetition"],
	"习惯追踪": ["习惯追踪", "habit tracker"],
	"闪卡": ["闪卡", "flashcards"],
	// 阅读与文献
	"网页剪藏": ["网页剪藏", "web clipper"],
	"网页高亮": ["网页高亮", "web highlighting"],
	"稍后阅读": ["稍后阅读", "read later"],
	// 中英混合词同时登记「紧凑」与「带空格」两种写法：查询侧匹配的是压缩空格后的
	// query（只需紧凑形态即可命中），索引侧比对的是插件原文，两种写法都可能出现。
	//
	// 这一组刻意收录了**插件描述里真实出现的说法**（PDF注释 / pdf 注释 / annotate pdf …）：
	// 中文侧靠 CJK 三元组时，「PDF 标注」只会匹配到原文里连写的「pdf标注」，
	// 而真阳性插件大多写的是「PDF 注释」「pdf annotation」；短语倒排表能按连续子串命中，
	// 正好补上三元组分词的盲区（实测把「PDF 标注」precision@10 从 2/10 提到 8/10）。
	"PDF标注": [
		"PDF标注",
		"PDF 标注",
		"PDF注释",
		"PDF 注释",
		"pdf注释",
		"pdf 注释",
		"pdf annotation",
		"pdf annotate",
		"annotate pdf",
		"pdf highlight",
		"pdf markup",
	],
	"文献管理": ["文献管理", "reference management", "citation management"],
	"会议纪要": ["会议纪要", "meeting notes"],
	// AI 与检索
	"本地AI": ["本地AI", "本地 AI", "local llm", "ollama"],
	"语义搜索": ["语义搜索", "semantic search"],
	"向量搜索": ["向量搜索", "vector search"],
	// 「写作助手 / 写作助理」是 AI 写作插件描述里的高频说法，而普通写作插件几乎不用；
	// 用它做短语锚点，才能把「AI 写作」和「写作」区分开（实测 precision@10 1/10 → 5/10）。
	"AI写作": [
		"AI写作",
		"AI 写作",
		"ai写作",
		"ai writing",
		"ai writer",
		"ai writing assistant",
		"写作助手",
		"写作助理",
		"AI写作助手",
		"AI 写作助手",
	],
	// 文件与媒体
	"图片压缩": [
		"图片压缩",
		"压缩图片",
		"压缩图像",
		"图片压缩工具",
		"image compress",
		"compress image",
		"image compression",
		"tinypng",
		"pngquant",
		"mozjpeg",
		"webp",
	],
	"图片粘贴": ["图片粘贴", "image paste"],
	// 文本工具
	"代码高亮": ["代码高亮", "code highlight", "syntax highlight"],
	"字数统计": ["字数统计", "word count"],
	// 文件与版本
	"版本控制": ["版本控制", "version control"],
	"文件夹导航": ["文件夹导航", "folder navigation"],
	"预览窗口": ["预览窗口", "preview window"],
};

/**
 * 高风险泛词权重（0~1）：命中量极大、语义漂移严重。
 *
 * 这类词在两个位置都要降权 ——
 *   a) 用户直接输入该英文词（或命中同名中文 key）时的原 query token；
 *   b) **别名短语内部的 token**：`向量搜索 → vector search` 里的 search、
 *      `甘特图 → gantt chart` 里的 chart、`知识图谱 → knowledge graph` 里的 graph。
 *      不降权就会把候选池从几十条拉宽到几百条，精确概念被同义词自带的泛词稀释。
 * 中文侧的高风险 key（笔记/链接/…）也登记在这里，供 key 分支取用。
 *
 * ⚠️ 这里的数字是**最终上限**，不是「每次注入的折扣」：逐次降权挡不住累加
 * （同一泛词出现在多条别名里，或既来自原 query 又来自别名），因此 expandQueryTerms
 * 在累加结束后会对本表的 token 再统一封顶一次。改这里的数值即同时改了最终上限。
 */
export const PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS: Record<string, number> = {
	// 中文侧：tier 3 高风险 key
	"笔记": 0.4,
	"链接": 0.4,
	"文件": 0.4,
	"时间": 0.4,
	"图表": 0.4,
	"代码": 0.4,
	"搜索": 0.4,
	"图片": 0.4,
	"同步": 0.4,
	// ASCII 侧：与上面一一对应的英文写法
	note: 0.4,
	notes: 0.4,
	link: 0.4,
	links: 0.4,
	file: 0.4,
	files: 0.4,
	image: 0.4,
	search: 0.4,
	sync: 0.4,
	chart: 0.4,
	graph: 0.4,
	code: 0.4,
	time: 0.4,
	management: 0.4,
	manager: 0.4,
	// AI 同样是高风险泛词：不封顶的话「本地 AI」里 ai 会以 3 倍权重（原 query + local ai
	// + offline ai）压过 local/llm/ollama，普通 AI 写作插件就会占满结果。
	ai: 0.4,
	// pdf / image 是「格式词」而不是「功能词」：语料里 161 个插件与 PDF 相关、307 个与图片相关，
	// 光提到格式不能说明它做的是「PDF 标注」「图片压缩」。不封顶时 pdf-writer/pdf-printer/
	// image-search/image-size 这类插件会靠格式词在名称里的高词频压过真正的功能插件
	// （实测「PDF 标注」precision@10 因此只有 2/10）。
	pdf: 0.4,
};

/**
 * 中泛化领域词权重（0~1）：含义清楚但覆盖面偏大。
 *
 * 只在两处生效：命中同名中文 key 时整体降权、用户直接输入该英文词时降权。
 * **不参与别名内部 token 降权** —— canvas / whiteboard 是「无限画布」这类精确
 * 概念的领域词，在别名里保留满权重才能让画布类插件正常进候选；
 * 精确概念靠「长 key 抑制子词 + 精确短语加权」拉开差距，而不是靠把领域词压低。
 */
const PLUGIN_MEDIUM_DOMAIN_WEIGHTS: Record<string, number> = {
	"画布": 0.35,
	"白板": 0.4,
	canvas: 0.35,
	whiteboard: 0.4,
	freeform: 0.35,
};

/**
 * 泛词权重总表：key 分支与「用户直接输入英文」的预降权统一查这张表。
 *
 * 泛词仍然保留召回能力，只是不能压过同时命中精确短语的文档。权重只作用于
 * 查询侧，不改变文档长度归一化，也不会让已有的普通关键词查询完全失效。
 *
 * 两点说明，避免后来者踩坑：
 * 1. 单独用泛词查询（如只输入「笔记」）时，原 query token 与全部别名会被同比例
 *    封顶，BM25 是 query 权重线性的，因此**排序不变** —— 降权的收益只体现在
 *    「泛词 + 精确词」混合查询里（例如「双链 笔记」时 wikilink/backlink 压过 note，
 *    或「本地 AI」时 ollama/local llm 压过只写 AI 的通用助手）。
 * 2. 权重是「上限」语义（cap，不是乘）：同一个泛词可能既来自原 query 又被命中的
 *    key 再处理一次，乘法会平方衰减，cap 则幂等。
 */
export const PLUGIN_GENERIC_WORD_WEIGHTS: Record<string, number> = {
	...PLUGIN_MEDIUM_DOMAIN_WEIGHTS,
	...PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS,
};

/** 查询词及其相对权重，供 BM25 倒排召回使用。 */
export interface ExpandedQueryTerm {
	term: string;
	weight: number;
}

/**
 * 压缩「ASCII 与 CJK 之间的空格」，只用于**匹配**，不改变返回给调用方的 query。
 *
 * 为什么需要：词表 key 统一写成无空格形态（`AI写作`、`PDF标注`、`本地AI`），
 * 但用户两种写法都会用（「AI 写作」「AI写作」）。若不做归一，就得为每个混合词
 * 维护两份重复条目，既膨胀词表又容易漏改。这里在匹配前抹掉 ASCII↔CJK 之间的
 * 空格，让一份 key 同时覆盖两种输入。
 *
 * 只处理相邻的空格，不动其它空白（`画布 白板` 这种两个中文词之间的空格保留，
 * 因为 `expandQuery` 的「独立词」判定依赖它）。
 */
function compactAsciiCjkSpacing(text: string): string {
	return text
		.replace(/([a-z0-9])\s+([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/gi, "$1$2")
		.replace(/([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s+([a-z0-9])/gi, "$1$2");
}

/** 对文本分词并累加 query term 权重。 */
function addWeightedText(target: Map<string, number>, text: string, weight: number): void {
	if (!text || weight <= 0) return;
	for (const term of tokenizeForExpansion(text)) {
		target.set(term, (target.get(term) ?? 0) + weight);
	}
}

/**
 * 把已存在 token 的权重压到不超过 maxWeight（**取 min，不是相乘**）。
 *
 * 用 min 而非乘法是为了幂等：同一个泛词可能既来自原 query（预降权）又来自命中的
 * 泛词 key（key 分支再降一次），相乘会把权重平方衰减（AI → 0.4²），与别名权重
 * 不一致。min 保证「泛词权重是上限」这一语义，重复应用不出错。
 */
function capWeightedText(target: Map<string, number>, text: string, maxWeight: number): void {
	for (const term of tokenizeForExpansion(text)) {
		const current = target.get(term);
		if (current !== undefined) target.set(term, Math.min(current, maxWeight));
	}
}

/**
 * 按 token 注入别名短语，并对别名内部的**高风险泛词**降权。
 *
 * 同一 key 的多条别名只是「同一个概念的不同说法」，因此同一个 token 在一个 key 内
 * **只计一次、取最大权重**：逐条累加会让 `AI 写作` 的 writing 变成 3、
 * `无限画布` 的 canvas 变成 2 —— 那是别名条数的副产物，不是重要性的证据。
 * （跨 key 的累加仍然保留：`笔记 同步` 里 note 与 sync 各自来自不同的概念。）
 *
 * 注意这里查的是 PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS 而非总表：canvas / whiteboard
 * 属中泛化领域词，在别名内部保留满权重（见该常量注释）。
 */
function collectAliasTokens(aliases: string[], baseWeight: number, genericCap: number | null): Map<string, number> {
	const perKey = new Map<string, number>();
	for (const alias of aliases) {
		for (const term of tokenizeForExpansion(alias)) {
			const tokenWeight = PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS[term];
			let weight = tokenWeight !== undefined ? Math.min(baseWeight, tokenWeight) : baseWeight;
			if (genericCap !== null) weight = Math.min(weight, genericCap);
			perKey.set(term, Math.max(perKey.get(term) ?? 0, weight));
		}
	}
	return perKey;
}

/** 与 BM25 保持一致的轻量分词，避免词表模块反向依赖 search/domain。 */
function tokenizeForExpansion(text: string): string[] {
	const out: string[] = [];
	const normalized = text.toLowerCase();
	const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
	const ascii = /[a-z0-9_-]/i;
	let i = 0;
	while (i < normalized.length) {
		if (cjk.test(normalized[i])) {
			let end = i;
			while (end < normalized.length && cjk.test(normalized[end])) end++;
			const run = normalized.slice(i, end);
			if (run.length <= 3) out.push(run);
			else for (let s = 0; s <= run.length - 3; s++) out.push(run.slice(s, s + 3));
			i = end;
		} else if (ascii.test(normalized[i])) {
			let end = i;
			while (end < normalized.length && ascii.test(normalized[end])) end++;
			out.push(normalized.slice(i, end));
			i = end;
		} else {
			i++;
		}
	}
	return out;
}

/**
 * 生成带权重的查询词。
 *
 * 精确短语的连续命中由 BM25 索引侧单独 boost；这里仅生成普通 token 权重。中文
 * 的三元组仍要求连续字符，因此不会把「无限」和「画布」两个分散词误当作短语命中。
 */
export function expandQueryTerms(query: string): ExpandedQueryTerm[] {
	const q = compactAsciiCjkSpacing(query.toLowerCase());
	const weights = new Map<string, number>();
	addWeightedText(weights, query, 1);
	// ASCII 泛词不一定是 PLUGIN_SYNONYMS 的 key（例如用户直接输入 canvas），
	// 先处理原 query，保证它和中文泛词一样降权。
	for (const [word, weight] of Object.entries(PLUGIN_GENERIC_WORD_WEIGHTS)) {
		if (isAsciiKey(word) && getAsciiKeyRegex(word).test(q)) capWeightedText(weights, word, weight);
	}

	const entries = Object.entries(PLUGIN_SYNONYMS).sort((a, b) => b[0].length - a[0].length);
	const matchedKeys: string[] = [];
	for (const [cn, aliases] of entries) {
		const key = cn.toLowerCase();
		if (matchedKeys.some((longer) => longer.includes(key))) continue;
		const hit = isAsciiKey(key)
			? getAsciiKeyRegex(key).test(q)
			: q.includes(key);
		if (!hit) continue;
		matchedKeys.push(key);

		const genericKeyWeight = PLUGIN_GENERIC_WORD_WEIGHTS[key] ?? 1;
		const isGenericKey = genericKeyWeight < 1;
		// 自然语言句子中的长词可能被 CJK 三元组切碎；精确短语无论是否独立
		// 出现都由短语倒排表处理；泛词则只在原 query 不是独立词时补一个轻量锚点。
		const standalone = q.split(/\s+/).some((part) => part === key);
		if (isGenericKey) {
			// 用户直接输入「画布」时，原 query 本身已有一个同名 token；把它
			// 也封顶，避免只降别名却仍让原词以满权重参与排序。
			// 用 cap（min）而非乘：上面 ASCII 预降权可能已处理过同一个词。
			capWeightedText(weights, cn, genericKeyWeight);
		}
		if (!standalone) {
			addWeightedText(weights, cn, genericKeyWeight);
		}

		// 别名内部的 token 逐个按泛词表降权：`vector search` 里的 search、
		// `gantt chart` 里的 chart 都不该以满权重把候选池拉宽。
		const aliasTokens = collectAliasTokens(
			aliases,
			isGenericKey ? genericKeyWeight : 1,
			isGenericKey ? genericKeyWeight : null
		);
		for (const [term, weight] of aliasTokens) {
			weights.set(term, (weights.get(term) ?? 0) + weight);
		}
	}

	// ── 泛词权重的**最终封顶** ──
	// 上面的降权都是「逐次注入」时生效，累加本身不受限：同一个泛词出现在多个别名里
	// （`AI 写作 → ai writing` 的 ai、`向量搜索 → vector search / similarity search` 的 search），
	// 或者既来自原 query 又来自别名时，权重会累加到 cap 之上（实测 ai=0.8~1.2、search=0.8、image=0.8）。
	// 那样「泛词权重是上限」就名不副实 —— 泛词反而因为别名多而权重更高。
	// 所以这里对累加结果再封顶一次，保证任何来源叠加后都不超过该泛词的上限。
	//
	// 只封顶高风险泛词表：canvas / whiteboard / freeform 属中泛化领域词，
	// 在别名内部必须保留累加权重（「无限画布」的 canvas 来自 infinite canvas + freeform canvas），
	// 否则画布类插件会被自己的同义词挤出候选池（曾实测前 10 精度 9/10 → 3/10）。
	for (const [term, weight] of weights) {
		const cap = PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS[term];
		if (cap !== undefined && weight > cap) weights.set(term, cap);
	}

	return Array.from(weights, ([term, weight]) => ({ term, weight }));
}

/**
 * 找到查询中命中的词表精确短语，并返回该概念的中英文完整短语变体。
 *
 * 英文查询也可以直接触发：用户输入 `infinite canvas` 时会得到与「无限画布」
 * 相同的短语集合。BM25 索引据此做连续子串匹配，不退化成两个独立英文单词。
 */
export function findMatchedExactPhrases(query: string): string[] {
	const q = compactAsciiCjkSpacing(query.toLowerCase());
	const matched = new Set<string>();
	for (const phrases of Object.values(PLUGIN_EXACT_PHRASES)) {
		if (!phrases.some((phrase) => containsExactPhrase(q, phrase.toLowerCase()))) continue;
		for (const phrase of phrases) matched.add(phrase);
	}
	return Array.from(matched);
}

/** CJK 直接子串；ASCII 短语额外检查词边界，避免命中 `canvases` 这类变体。 */
function containsExactPhrase(text: string, phrase: string): boolean {
	const asciiPhrase = /^[a-z0-9 _-]+$/i.test(phrase);
	let from = 0;
	while (from <= text.length - phrase.length) {
		const at = text.indexOf(phrase, from);
		if (at < 0) return false;
		if (!asciiPhrase) return true;
		const before = at > 0 ? text[at - 1] : "";
		const after = text[at + phrase.length] ?? "";
		if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true;
		from = at + 1;
	}
	return false;
}

/** 扩展 query：把 query 中命中的中文词追加其英文别名到末尾（vault-curate 的 expandQuery 思路）。
 * 匹配先统一转小写，避免 "ai" 小写时不命中 "AI" 键；
 * 纯 ASCII 键（如 "AI"）用词边界 \b 匹配，避免误命中 "email"/"tai" 等含子串的词。 */
export function expandQuery(query: string): string {
	const q = compactAsciiCjkSpacing(query.toLowerCase());
	let expanded = query;
	// 先匹配长词，避免「无限画布」同时命中「画布」而重复注入泛化的
	// canvas/whiteboard 词，导致普通 Canvas 插件挤掉真正的长词匹配。
	const matchedKeys: string[] = [];
	const entries = Object.entries(PLUGIN_SYNONYMS).sort((a, b) => b[0].length - a[0].length);
	for (const [cn, aliases] of entries) {
		const key = cn.toLowerCase();
		if (matchedKeys.some((longer) => longer.includes(key))) continue;
		// PERF micro：ASCII 键用词边界正则，预编译到模块级避免每次调用现场构造
		const hit = isAsciiKey(key)
			? getAsciiKeyRegex(key).test(q)
			: q.includes(key);
		if (hit) {
			matchedKeys.push(key);
			// 把命中的中文概念单独追加一次。自然语言查询中的概念通常嵌在
			// 更长的 CJK 句子里，三元组分词会把「画布」切成「个画布/画布相」；
			// 单独追加可保留精确锚点，再用英文别名连接英文插件名。
			const isExactConcept = q.split(/\s+/).some((part) => part === key);
			const anchor = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(cn) && !isExactConcept ? `${cn} ` : "";
			expanded += " " + anchor + aliases.join(" ");
		}
	}
	return expanded;
}

const ASCII_KEY_RE = /^[a-z0-9_-]+$/;
function isAsciiKey(key: string): boolean {
	return ASCII_KEY_RE.test(key);
}

/** ASCII 键 → 预编译词边界正则（模块级缓存，键集合稳定）。 */
const ASCII_KEY_REGEX_CACHE = new Map<string, RegExp>();
function getAsciiKeyRegex(key: string): RegExp {
	let re = ASCII_KEY_REGEX_CACHE.get(key);
	if (!re) {
		re = new RegExp(`\\b${escapeRegExp(key)}\\b`);
		ASCII_KEY_REGEX_CACHE.set(key, re);
	}
	return re;
}

/** 转义正则特殊字符（key 含 -/_ 等时避免 RegExp 解析错误） */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
