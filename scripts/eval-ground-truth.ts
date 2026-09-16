/**
 * 人工正例集（ground truth）—— 召回验收的唯一判据。
 *
 * 为什么需要它：早期版本用「包含 image/pdf/writing/graph 等泛词」的正则判定相关性，
 * 等于让评估脚本自己给自己打分：`图片压缩` 用 /image|compress|图片|压缩/ 判定时，
 * 任何图片插件都算命中，于是「precision@10 = 10/10」是假的。这里改成**逐条列出插件 id**
 * 并附上入选证据，任何人都能逐条复核、也能直接反驳某一条。
 *
 * 判定标准（criterion 字段逐查询写明）：
 *   strong = 该插件的**主要功能**就是查询所指的能力；
 *   weak   = 该能力是插件主要功能之一，但不是唯一/核心（例如多视图插件里的一个视图）。
 * 报告同时给出「只算 strong」与「strong+weak」两组数字，便于对边界条目有异议时对照。
 *
 * 已知局限（必须如实标注）：
 *   1. 正例集由人（AI 助手）人工标注，不是独立第三方标注，仍有主观性 —— 但它是**可审计**的：
 *      每条都带证据，可逐条挑战。
 *   2. 正例集的**完整性**没有保证：候选来自「插件文本提到概念词」的宽正则，
 *      完全没提到概念词的真阳性（例如 `study-pdf` 只写「PDF 注释」不写 annotation）会被漏掉，
 *      因此 recall 是**下界**，precision 相对可靠。
 *   3. 只覆盖 6 个验收查询；其余查询的正则数字已在报告里标注为「不可作为验收依据」。
 */

export type Relevance = "strong" | "weak";

export interface GroundTruthEntry {
	/** 查询词 */
	query: string;
	/** 相关性判定标准（写清楚才算可审计） */
	criterion: string;
	/** 正例：插件 id → 入选证据（取自 seeded-translator-cache.json 的中文译名/译文） */
	positives: Record<string, { relevance: Relevance; evidence: string }>;
	/** 边界说明 / 明确排除的反例 */
	boundary?: string;
}

export const GROUND_TRUTH: GroundTruthEntry[] = [
	{
		query: "图片压缩",
		criterion:
			"插件的主要功能包含「压缩图片」（降低图片文件体积）。仅做格式转换/缩放显示尺寸、或把压缩作为附带功能的（上传、备份、导出、拍照）不算正例。",
		positives: {
			"local-image-compress": { relevance: "strong", evidence: "本地 PNG/JPEG 压缩，使用系统 pngquant/mozjpeg" },
			"tinypng-image": { relevance: "strong", evidence: "使用 TinyPNG 压缩图像以节省存储空间" },
			"paste-image-as-webp": { relevance: "strong", evidence: "粘贴图片为压缩的 WebP 文件，带质量设置" },
			"obsidian-paste-png-to-jpeg": { relevance: "strong", evidence: "截图 png 到 jpeg 并压缩和重命名" },
			"image-converter": { relevance: "strong", evidence: "转换、压缩、调整大小、批量处理图像" },
			"image-magick": { relevance: "strong", evidence: "调整大小、裁剪、旋转、压缩和转换图像" },
			"local-image-resizer": { relevance: "strong", evidence: "在本地调整图像大小、转换和压缩图像" },
			"note-image-manager": { relevance: "strong", evidence: "图像工作流：导入、重命名、转换、压缩、编辑" },
		},
		boundary:
			"排除：`compress`（通用文件压缩，非图片专项）、`watermark-bucket-uploader`/`s-three-image-sync-pro`/`ezimage`/`notepic-oss`/`bitiful-helper`（上传为主，压缩附带）、`pdf-export-compress`（PDF 导出为主）、`camera-embed`（拍照为主）、`resize-pics`（只改显示尺寸不改体积）、`image-search`/`image-inline`/`image-size`/`image-cluster`/`obsidian-image-gallery`（图片查看/搜索/画廊，不压缩）。",
	},
	{
		query: "PDF 标注",
		criterion:
			"插件的主要功能包含「对 PDF 做标注/批注」（高亮、墨迹、页边注释、文本批注）。只做 PDF 阅读、导出、打印、粘贴、版本管理，或只从 PDF **提取/导入**已有标注的，不算正例。",
		positives: {
			"study-pdf": { relevance: "strong", evidence: "突出显示文本并向 PDF 添加注释，保存到文件本身" },
			siden: { relevance: "strong", evidence: "使用突出显示、页边注释和审阅侧边栏对 Markdown 和 PDF 文本进行注释" },
			"obsidian-annotator": { relevance: "strong", evidence: "阅读 PDF 和 EPUB 文件并为其添加注释" },
			"handwritten-notes": { relevance: "strong", evidence: "对 PDF 进行注释并创建手写笔记" },
			"pdf-plus": { relevance: "strong", evidence: "最 Obsidian 原生的 PDF 注释工具" },
			"pdf-notes": { relevance: "strong", evidence: "使用墨迹绘图和形状工具对 PDF 进行注释" },
			jot: { relevance: "strong", evidence: "使用 Apple Pencil 对 PDF 进行注释" },
			"local-pdf-annotator": { relevance: "strong", evidence: "阅读 PDF、突出显示段落、放置页面注释" },
			"oppopad-pdf-annotation": { relevance: "strong", evidence: "手写笔优先的 PDF 注释，压敏墨水" },
			"freedraw-pdf": { relevance: "strong", evidence: "手绘 PDF 注释工作区" },
			"ink-annotation": { relevance: "strong", evidence: "PDF 文本选择注释（突出显示、下划线、删除线、注释）+ 墨迹" },
			"reader-margins": { relevance: "strong", evidence: "在 Obsidian 内置 PDF 阅读器上进行页边注释" },
			"slide-note": { relevance: "weak", evidence: "方便地在 PDF 课程幻灯片上做笔记" },
			zotflow: { relevance: "weak", evidence: "Zotero/PDF/Annotation 工作流" },
			"obsidian-markmind": { relevance: "weak", evidence: "思维导图、大纲和 PDF 注释工具" },
			pdftion: { relevance: "weak", evidence: "PDF 注释、编辑、导出工具" },
			"pdf-scholia-scribe": { relevance: "weak", evidence: "以引文为中心的 PDF 注释和注释链接" },
			"pdf-highlight-notes": { relevance: "weak", evidence: "将文本选择保存为突出显示注释" },
		},
		boundary:
			"排除：`obsidian-extract-pdf-highlights`/`obsidian-extract-pdf-annotations`/`classy-pdf-extractor`/`bookfusion`/`zotero-highlights-sync`（只提取或导入已有标注）、`pdf-writer`/`pdf-printer`/`pdf-paste`/`pdf-scroll-lock`/`pdf-folder-to-markdowns`/`better-pdf-plugin`/`pdf-plus` 之外的 PDF 工具（阅读/导出/打印/粘贴/滚动）、`enhanced-annotations`（面向 Markdown 的评论侧栏，非 PDF）。",
	},
	{
		query: "AI 写作",
		criterion:
			"插件的主要功能包含「用 AI 生成/续写/润色/改写正文」。只做通用 AI 聊天、翻译、摘要、OCR、检索问答的不算正例；纯人工写作工具（无 AI）也不算。",
		positives: {
			wordwise: { relevance: "strong", evidence: "人工智能内容生成的写作伴侣" },
			"smart-composer": { relevance: "strong", evidence: "人工智能聊天、智能写作帮助、一键编辑" },
			rosypilot: { relevance: "strong", evidence: "人工智能驱动的法律写作内联补全" },
			smartscribe: { relevance: "strong", evidence: "人工智能驱动的写作助手，优化您的写作" },
			"writers-alembic": { relevance: "strong", evidence: "AI 写作工作流程工具" },
			"writing-assistant-chat": { relevance: "strong", evidence: "人工智能写作助手，本地或云提供商" },
			"ai-writer": { relevance: "strong", evidence: "利用 AI 生成高质量文章" },
			nova: { relevance: "strong", evidence: "人工智能写作伙伴，选择文本进行转换" },
			"ai-copilot": { relevance: "strong", evidence: "智能写作和思考助手" },
			"ai-autocomplete": { relevance: "strong", evidence: "内联 AI 书写完成与幽灵文本" },
			bojubot: { relevance: "strong", evidence: "写作助手，用 Claude Code 改造金库" },
			"echo-ai": { relevance: "strong", evidence: "人工智能驱动的写作助手，内联写入" },
			aide: { relevance: "strong", evidence: "AI 写作助手（OpenAI 兼容 API）" },
			"vault-ai": { relevance: "weak", evidence: "AI 助手：写作帮助、内容生成" },
			"reverse-prompter": { relevance: "weak", evidence: "生成提示让您继续用 AI 写作" },
			"vault-brain": { relevance: "weak", evidence: "本地多模态 AI，含人工智能写作" },
			scholarium: { relevance: "weak", evidence: "学术工作空间，含人工智能辅助写作" },
			"mantou-ai": { relevance: "weak", evidence: "翻译、润色、问答、总结的私人助理" },
			markpilot: { relevance: "weak", evidence: "内联完成和聊天视图" },
			"ai-bot": { relevance: "weak", evidence: "使用 AI 润色、总结、翻译" },
			proofreader: { relevance: "weak", evidence: "基于人工智能的写作校对和文体改进" },
			muse: { relevance: "weak", evidence: "无干扰写作模式 + AI 生成写作提示" },
			akaire: { relevance: "weak", evidence: "本地 AI 编辑器，审查你写作" },
			monolithos: { relevance: "weak", evidence: "AI 伴侣，把写作转化为播客和演示文稿" },
			ogstack: { relevance: "weak", evidence: "使用链接的笔记作为上下文进行写作" },
			"busy-goblins": { relevance: "weak", evidence: "AI 操作链，编写和重写 Markdown" },
			burnish: { relevance: "weak", evidence: "使用 AI 润色您的笔记" },
			meow: { relevance: "weak", evidence: "LLM 文本润色" },
			"markdown-to-card": { relevance: "weak", evidence: "支持 AI 文案转写" },
			"ai-voice-polish": { relevance: "weak", evidence: "语音录制 → AI 润色 → 插入笔记" },
		},
		boundary:
			"排除：`writing`/`perilous-writing`/`obsidian-incremental-writing`（无 AI 的写作工具）、`fountain`（剧本格式）、`smart-connections`（语义检索）、`handwriting-ocr`（OCR）、`realtime-transcription`（语音转写）、`gemini-assistant`（通用助手，描述无写作能力）。",
	},
	{
		query: "甘特图",
		criterion: "插件的主要功能包含「以甘特图/甘特式条形时间轴呈现任务或项目」。单纯的时间线、日历、看板不算正例。",
		positives: {
			"task-gantt": { relevance: "strong", evidence: "在交互式甘特时间轴上管理任务，拖拽栏、依赖项、里程碑" },
			"smart-gantt": { relevance: "strong", evidence: "从您的任务生成甘特图" },
			"gantt-tracker": { relevance: "strong", evidence: "用于实际项目跟踪的甘特图：计划与实际条形图" },
			giganttix: { relevance: "strong", evidence: "基于任务注释的简单甘特图" },
			chronoboard: { relevance: "strong", evidence: "甘特式时间板，用于项目时间跟踪" },
			"gantt-calendar": { relevance: "strong", evidence: "名称即甘特；任务可视化管理插件" },
			"folder-timeline": { relevance: "strong", evidence: "将任何文件夹转换为时间轴/甘特图视图" },
			"bullet-time": { relevance: "strong", evidence: "将项目符号列表转换为甘特式时间线" },
			markwhen: { relevance: "weak", evidence: "创建时间线、甘特图、日历等（多视图）" },
			"project-manager": { relevance: "weak", evidence: "项目管理：甘特图、看板、表格视图" },
			"bases-power-pack": { relevance: "weak", evidence: "Bases 视图包：看板、日历、甘特图…" },
			docket: { relevance: "weak", evidence: "项目管理：甘特图/WBS/看板视图" },
			"mermaid-gui-editor": { relevance: "weak", evidence: "Mermaid GUI 编辑器，含甘特图语法" },
		},
		boundary:
			"排除：纯时间线插件（`life-timeline`、`bases-timeline`、`chronicle-lanes`、`maps-timeline`、`advanced-bases`、`powerbases`、`relation-weaver`、`people-tree`）、纯看板/日历、以及只做 Mermaid 渲染/缩放/导出的插件。",
	},
	{
		query: "流程图",
		criterion:
			"插件为 Obsidian **新增**了创建/编辑/渲染流程图的能力（自带 flowchart/mermaid/plantuml/nomnoml/bpmn 等 DSL 渲染或可视化编辑器）。只做 Mermaid 的缩放/导出/主题/复制/语法修复（Obsidian 已内置渲染）不算正例。",
		positives: {
			flowcharts: { relevance: "strong", evidence: "使用 flowchart.js 标记渲染流程图" },
			"mermaid-flow": { relevance: "strong", evidence: "通过拖动节点和绘制连接来创建和编辑 Mermaid 流程图" },
			"draw-a-mermaid": { relevance: "strong", evidence: "直观地构建美人鱼流程图" },
			"flowscript-diagrams": { relevance: "strong", evidence: "将 flow 代码块渲染为内联 SVG 流程图" },
			"mermaid-maker": { relevance: "strong", evidence: "美人鱼图的内联 GUI 编辑器" },
			"simple-draw": { relevance: "strong", evidence: "用于简单流程图的轻量级绘图插件" },
			"bpmn-plugin": { relevance: "strong", evidence: "使用 bpmn-js 查看 BPMN 图表" },
			"obsidian-plantuml": { relevance: "strong", evidence: "生成 PlantUML 图" },
			"obsidian-nomnoml-diagram": { relevance: "strong", evidence: "绘制 nomnoml 图" },
			"puml-viewer": { relevance: "strong", evidence: "从 .puml 文件和代码块渲染 PlantUML" },
			"plantuml-integrator": { relevance: "strong", evidence: "渲染 PlantUML 代码块与 .puml 嵌入" },
			pumler: { relevance: "strong", evidence: "渲染 PlantUML、Structurizr 和 Mermaid 图表" },
			"mermaid-gui-editor": { relevance: "strong", evidence: "GUI 编辑器编辑 Mermaid 流程图" },
			"mermaid-canvas": { relevance: "strong", evidence: "增强的 Mermaid 编辑器，自适应画布" },
			"x86-flow-graphing": { relevance: "weak", evidence: "将 x86 汇编转换为流程图（领域受限）" },
		},
		boundary:
			"排除：Mermaid 的缩放/导出/主题/复制/修复类（`mermaid-flow-zoom`、`mermaid-zoom`、`mermaid-view`、`mermaid-exporter`、`mermaid-copy`、`mermaid-block-to-image`、`mermaid-themes`、`mermaid-fixer`、`mermaid-fit`、`beauty-diagram`、`slick-mermaid`、`better-mermaid`、`owen-mermaid`、`mermaid-lens`、`mermaid-helper`、`mermaid-tools`、`mermaid-icons`、`mermaid-explorer`、`mermaid-base-views`、`mermaid-elk`、`mermaid-elk-renderer`、`mermaid-next`、`beautiful-mermaid-renderer`、`auto-beautiful-mermaid`）、PDF/HTML 导出类、以及只把 Mermaid 当附带功能的（`paper-flow`、`html-effectiveness`、`omni-viewer`、`canvas-export`）。\n**边界（有争议，可复议）**：`advanced-canvas`、`canvas-enhance`、`moredraw`、`mermaid-popup` 的描述里写了「创建演示文稿、流程图等」或「绘制流程图」，按「主要功能」标准我判为非正例（它们是画布/查看器插件，流程图只是顺带能力）；若采用更宽松的标准，它们应算 weak 正例，届时「流程图」precision@10 会从 6/10 升到 8/10（strong 仍为 5/10）。",
	},
	{
		query: "知识图谱",
		criterion:
			"插件的主要功能包含「从笔记中构建/增强知识图谱」（实体与关系抽取、知识网络分析、Graph RAG）。**语义歧义**：中文「知识图谱」也可能被理解为 Obsidian 自带的图谱视图（graph view）增强，这里采用「构建知识图谱」这一严格解释，另附宽松解释的正例供对照。",
		positives: {
			"knowledge-graph-ai": { relevance: "strong", evidence: "知识图谱 + 人工智能" },
			"knowledge-graph-analysis": { relevance: "strong", evidence: "知识图谱分析" },
			"knowledge-atlas": { relevance: "strong", evidence: "知识图谱 / 知识地图" },
			"simple-graph-builder": { relevance: "strong", evidence: "使用 LLM 支持的实体提取从笔记构建知识图" },
			thirdbrain: { relevance: "strong", evidence: "把零散思想变成自我净化的知识图谱，提取可验证命题" },
			spider: { relevance: "strong", evidence: "AI 聊天分支为交互式知识图谱" },
			"spherical-knowledge-graph": { relevance: "strong", evidence: "把库变成 3D 知识领域，含语义链接" },
			"vault-intelligence": { relevance: "strong", evidence: "通过 Graph RAG 按相似性和显式链接检索上下文" },
			understory: { relevance: "strong", evidence: "本地优先知识层，用于关系发现与图形分析" },
			"infranodus-graph-view": { relevance: "strong", evidence: "InfraNodus AI 知识图谱分析视图" },
			"zettelkasten-branch-tracker": { relevance: "weak", evidence: "Zettelkasten 层次结构的图形可视化" },
			"thought-agent": { relevance: "weak", evidence: "自主图形感知助手，创建智能思维导图" },
			"spectacles-sync": { relevance: "weak", evidence: "以 3D 知识图形式探索笔记" },
			"reference-map": { relevance: "weak", evidence: "参考文献与引文地图" },
			"semantic-auto-linker": { relevance: "weak", evidence: "把库作为本地语义空间探索，建议缺失链接" },
		},
		boundary:
			"宽松解释下还应包含 Obsidian 图谱视图增强类（`juggl`、`3d-graph`、`3d-graph-new`、`three-d-graph-view`、`spherical-graph`、`roam-graph`、`persistent-graph`、`obsidian-living-graph`、`synapses`、`graph-nested-tags`、`graph-link-types`、`folders2graph`、`tags-routes`）—— 这些插件不构建知识图谱，只是图形视图工具，故未计入严格正例。",
	},
];

/** 按查询名取正例集。 */
export function groundTruthFor(query: string): GroundTruthEntry | undefined {
	return GROUND_TRUTH.find((e) => e.query === query);
}
