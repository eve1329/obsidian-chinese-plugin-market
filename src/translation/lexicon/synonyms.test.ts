import { describe, it, expect } from "vitest";
import {
	expandQuery,
	expandQueryTerms,
	findMatchedExactPhrases,
	PLUGIN_EXACT_PHRASES,
	PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS,
	PLUGIN_GENERIC_WORD_WEIGHTS,
	PLUGIN_SYNONYMS,
} from "@translation/lexicon/synonyms";

/** 取「token → 权重」便于断言，避免在断言里反复做数组查找。 */
function termWeights(query: string): Map<string, number> {
	return new Map(expandQueryTerms(query).map((entry) => [entry.term, entry.weight]));
}

describe("expandQuery 同义词扩展", () => {
	it("命中中文词时追加英文别名", () => {
		const out = expandQuery("思维导图");
		expect(out).toContain("mind map");
		expect(out).toContain("markmap");
	});
	it("无限画布查询同时保留中文锚点和英文别名", () => {
		const out = expandQuery("我想找一个无限画布相关的插件");
		expect(out).toContain("无限画布");
		expect(out).toContain("infinite canvas");
		expect(expandQuery("找一个画布插件")).toContain("画布 canvas");
	});
	it("未命中的 query 原样返回", () => {
		expect(expandQuery("Notion")).toBe("Notion");
	});
	it("多个同义词命中都追加", () => {
		const out = expandQuery("笔记 同步");
		expect(out).toContain("note");
		expect(out).toContain("sync");
	});
	it("精确短语表可从中文或英文查询命中完整变体", () => {
		expect(findMatchedExactPhrases("找一个无限画布插件")).toEqual(PLUGIN_EXACT_PHRASES["无限画布"]);
		expect(findMatchedExactPhrases("infinite canvas plugin")).toEqual(PLUGIN_EXACT_PHRASES["无限画布"]);
		expect(findMatchedExactPhrases("infinite canvases plugin")).toEqual([]);
	});
	it("泛词只保留低权重召回", () => {
		const terms = new Map(expandQueryTerms("画布").map((entry) => [entry.term, entry.weight]));
		expect(terms.get("画布")).toBe(PLUGIN_GENERIC_WORD_WEIGHTS["画布"]);
		expect(terms.get("canvas")).toBe(PLUGIN_GENERIC_WORD_WEIGHTS.canvas);
		expect(terms.get("infinite")).toBe(PLUGIN_GENERIC_WORD_WEIGHTS["画布"]);
	});
	it("同义词表非空且格式正确", () => {
		expect(Object.keys(PLUGIN_SYNONYMS).length).toBeGreaterThan(20);
		for (const [cn, aliases] of Object.entries(PLUGIN_SYNONYMS)) {
			expect(cn.length).toBeGreaterThan(0);
			expect(aliases.length).toBeGreaterThan(0);
		}
	});
});

/**
 * 新增领域词的英文锚点。
 *
 * 用表驱动而不是逐条 it()：这张表就是「词表契约」—— 改动别名时先改这里，
 * 失败信息会直接指出是哪个中文概念丢了哪个英文锚点。
 */
describe("expandQuery 新增领域词的英文锚点", () => {
	const CASES: Array<[string, string[]]> = [
		// 知识管理与笔记方法
		["卡片盒", ["zettelkasten", "slip box"]],
		["卡片笔记", ["zettelkasten", "slip box"]],
		["第二大脑", ["second brain", "personal knowledge management", "pkm"]],
		["个人知识管理", ["personal knowledge management", "pkm", "knowledge management"]],
		["知识库", ["knowledge base", "wiki"]],
		["知识管理", ["knowledge management"]],
		["原子笔记", ["atomic notes"]],
		["永久笔记", ["permanent notes", "evergreen notes"]],
		["文献笔记", ["literature notes"]],
		["读书笔记", ["reading notes", "book notes"]],
		["研究笔记", ["research notes"]],
		["概念图", ["concept map"]],
		["知识图谱", ["knowledge graph", "knowledge network"]],
		["知识网络", ["knowledge network"]],
		["内容地图", ["content map", "map of content"]],
		["MOC", ["map of content", "index note"]],
		["目录笔记", ["index note", "table of contents"]],
		["双链笔记", ["wikilink", "backlink"]],
		["反向链接", ["backlink"]],
		["入链", ["backlink", "incoming link"]],
		["出链", ["outgoing link"]],
		["页面链接", ["page link", "internal link"]],
		["块引用", ["block reference", "blockquote"]],
		["块链接", ["block link"]],
		["属性管理", ["properties", "metadata", "frontmatter"]],
		["元数据", ["metadata", "frontmatter"]],
		["Frontmatter", ["frontmatter", "yaml"]],
		// 可视化与结构化
		["自由画布", ["freeform canvas", "freeform workspace"]],
		["视觉工作区", ["visual workspace"]],
		["数字白板", ["digital whiteboard"]],
		["架构图", ["architecture diagram"]],
		["组织结构图", ["org chart"]],
		["网络图", ["network graph", "network diagram"]],
		["时间线", ["timeline"]],
		["时间轴", ["timeline", "time axis"]],
		["甘特图", ["gantt chart", "gantt"]],
		["矩阵", ["matrix"]],
		["四象限", ["four quadrants", "eisenhower matrix"]],
		["图库", ["gallery", "image gallery"]],
		["画廊", ["gallery"]],
		["仪表板", ["dashboard"]],
		// 任务、生产力
		["任务管理", ["task management", "task manager"]],
		["待办事项", ["todo", "to-do", "checklist"]],
		["任务清单", ["task list", "todo list"]],
		["任务看板", ["kanban board", "task board"]],
		["子任务", ["subtasks"]],
		["项目管理", ["project management", "project manager"]],
		["项目规划", ["project planning"]],
		["目标管理", ["goal management", "okr"]],
		["GTD", ["gtd", "getting things done"]],
		["收集箱", ["inbox"]],
		["快速捕获", ["quick capture"]],
		["日程安排", ["schedule", "planner"]],
		["日程规划", ["daily planner"]],
		["周计划", ["weekly planner"]],
		["月计划", ["monthly planner"]],
		["时间块", ["time blocking"]],
		["时间追踪", ["time tracking"]],
		["番茄工作法", ["pomodoro", "pomodoro timer"]],
		["打卡", ["habit tracker", "check-in"]],
		["提醒", ["reminder"]],
		["截止日期", ["due date", "deadline"]],
		["重复任务", ["recurring tasks"]],
		["工作流自动化", ["workflow automation", "automation"]],
		["闪卡", ["flashcards", "anki"]],
		// AI、搜索与知识增强
		["AI写作", ["ai writing", "writing assistant"]],
		["AI聊天", ["ai chat", "chatbot"]],
		["AI助手", ["ai assistant", "copilot"]],
		["AI摘要", ["ai summary", "summarization"]],
		["AI改写", ["ai rewrite", "paraphrase"]],
		["AI翻译", ["ai translation"]],
		["AI自动补全", ["autocomplete", "text completion"]],
		["AI绘图", ["text to image", "image generation"]],
		["本地AI", ["local ai", "local llm", "ollama", "offline ai"]],
		["本地大模型", ["local llm", "local model", "ollama"]],
		["本地模型", ["local model", "ollama"]],
		["大语言模型", ["large language model", "generative ai"]],
		["LLM", ["large language model"]],
		["RAG", ["retrieval augmented generation"]],
		["检索增强生成", ["retrieval augmented generation"]],
		["语义搜索", ["semantic search", "semantic retrieval"]],
		["向量搜索", ["vector search", "similarity search"]],
		["向量数据库", ["vector database", "vector store"]],
		["Embedding", ["embeddings", "vector embedding"]],
		["嵌入模型", ["embedding model"]],
		["知识问答", ["question answering"]],
		["语音转文字", ["speech to text", "transcription"]],
		["文本转语音", ["text to speech", "tts"]],
		["图像生成", ["image generation", "text to image"]],
		["提示词", ["prompt", "prompt engineering"]],
		["Prompt", ["prompting"]],
		// 阅读、研究与文献
		["网页高亮", ["web highlighting", "web annotations"]],
		["网页阅读", ["web reader", "reading mode"]],
		["稍后阅读", ["read later", "reading list"]],
		["PDF标注", ["pdf annotation", "pdf markup"]],
		["PDF阅读", ["pdf reader", "pdf viewer"]],
		["文献管理", ["reference management", "citation management", "zotero"]],
		["论文管理", ["paper management", "academic papers"]],
		["引用管理", ["citation management"]],
		["参考文献", ["references", "bibliography"]],
		["BibTeX", ["bibliography", "citation"]],
		["DOI", ["crossref"]],
		["文献检索", ["literature search", "academic search"]],
		["学术搜索", ["academic search", "google scholar"]],
		["批注", ["annotations", "markup"]],
		["会议记录", ["meeting notes", "meeting minutes"]],
		["会议纪要", ["meeting notes", "meeting minutes", "transcript"]],
		["转录", ["transcription", "transcript"]],
		["OCR", ["optical character recognition"]],
		["扫描识别", ["document scanning", "text recognition"]],
		// 写作、编辑与文本
		["长文写作", ["long-form writing", "manuscript"]],
		["Markdown编辑器", ["markdown editor"]],
		["富文本", ["rich text", "wysiwyg"]],
		["排版", ["typography", "typesetting"]],
		["语法检查", ["grammar checker", "proofreading"]],
		["拼写检查", ["spell checker"]],
		["同义词", ["thesaurus", "synonyms"]],
		["字数统计", ["word count", "character count"]],
		["改写", ["rewrite", "paraphrase"]],
		["格式化", ["formatter", "formatting"]],
		["代码块", ["code block", "codeblock"]],
		["代码高亮", ["syntax highlighting", "code highlight"]],
		["代码运行", ["code runner", "execute code"]],
		// 文件、媒体与同步
		["图片压缩", ["image compression", "compress image", "webp", "tinypng"]],
		["图片上传", ["image upload", "image hosting"]],
		["图床", ["image hosting", "picgo"]],
		["附件管理", ["attachment management"]],
		["文件管理", ["file management", "file manager"]],
		["文件重命名", ["file renaming", "rename"]],
		["重复文件", ["duplicate files", "deduplicate"]],
		["媒体库", ["media library"]],
		["相册", ["photo gallery", "album"]],
		["云同步", ["cloud sync", "cloud storage"]],
		["WebDAV", ["webdav"]],
		["静态网站", ["static site", "static website"]],
	];

	it.each(CASES)("「%s」扩展出预期英文锚点", (cn, expected) => {
		const out = expandQuery(cn);
		for (const alias of expected) expect(out).toContain(alias);
	});

	it("精确功能词都登记在精确短语表里（中文 + 英文双向锚点）", () => {
		for (const cn of ["卡片盒", "第二大脑", "个人知识管理", "知识图谱", "双链笔记", "甘特图", "时间线", "PDF标注", "文献管理", "会议纪要", "图片压缩", "向量搜索", "语义搜索", "本地AI", "工作流自动化", "闪卡"]) {
			expect(PLUGIN_EXACT_PHRASES[cn], `${cn} 缺少精确短语条目`).toBeDefined();
			expect(PLUGIN_EXACT_PHRASES[cn][0]).toBe(cn);
			expect(PLUGIN_EXACT_PHRASES[cn].length).toBeGreaterThan(1);
		}
	});
});

describe("同义词扩展的精度约束", () => {
	it("长词优先：命中精确概念后不再叠加其子词的泛化别名", () => {
		// 「无限画布」命中后必须跳过「画布」：若「画布」也被命中，canvas/whiteboard/freeform
		// 会被泛词权重压到 0.35 并封顶 —— 权重仍为满值即证明子词被正确跳过。
		const infinite = termWeights("无限画布");
		expect(infinite.get("whiteboard")).toBe(1);
		expect(infinite.get("freeform")).toBe(1);
		// canvas 同时出现在 `infinite canvas` 与 `freeform canvas` 两条别名里，
		// 但同一 key 内按 token 去重，只计一次
		expect(infinite.get("canvas")).toBe(1);

		// 「时间线」命中后跳过「时间」，不应再注入 time/clock/timer
		const timeline = termWeights("时间线");
		expect(timeline.get("timeline")).toBe(1);
		expect(timeline.has("clock")).toBe(false);
		expect(timeline.has("timer")).toBe(false);

		// 「云同步」命中后跳过「同步」
		const cloud = termWeights("云同步");
		expect(cloud.get("sync")).toBe(PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.sync);
		expect(cloud.has("syncing")).toBe(false);

		// 「双链笔记」同时跳过「双链」与「笔记」：不注入 obsidian / note 这类高风险泛词
		const dbl = termWeights("双链笔记");
		expect(dbl.get("wikilink")).toBe(1);
		expect(dbl.has("obsidian")).toBe(false);
		expect(dbl.has("note")).toBe(false);
	});

	it("精确概念的扩展词条数有界（不会把泛词的整片别名拉进来）", () => {
		expect(expandQueryTerms("双链笔记").length).toBeLessThan(12);
		expect(expandQueryTerms("读书笔记").length).toBeLessThan(12);
		expect(expandQueryTerms("时间线").length).toBeLessThan(12);
	});

	it("别名内部的泛词也被降权（vector search 里的 search、gantt chart 里的 chart）", () => {
		const vector = termWeights("向量搜索");
		expect(vector.get("vector")).toBe(1); // vector search + vector retrieval，同一 key 内去重
		expect(vector.get("search")).toBe(PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.search);
		expect(vector.get("search")!).toBeLessThan(vector.get("vector")!);

		const gantt = termWeights("甘特图");
		expect(gantt.get("gantt")).toBe(1); // gantt chart + gantt，同一 key 内去重
		expect(gantt.get("chart")).toBe(PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.chart);

		// 中泛化领域词不参与别名内部降权，也不参与最终封顶：「无限画布」的 canvas
		// 必须保留满权重，否则画布类插件会被自己的同义词挤出候选池
		// （曾实测前 10 精度 9/10 → 3/10）。
		expect(termWeights("无限画布").get("canvas")).toBe(1);
		expect(PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.canvas).toBeUndefined();
	});

	it("同一 key 的多条别名不会让同一个 token 权重叠加", () => {
		// 别名条数是「同一个概念的不同说法」，不是重要性的证据：
		// 逐条累加会让 `AI 写作` 的 writing 变成 3（实测会把普通写作插件顶到 AI 写作之前，
		// precision@10 只有 1/10），去重后降到 1。
		expect(termWeights("AI 写作").get("writing")).toBe(1);
		// 跨 key 的累加仍然保留：不同概念命中同一个 token 时才叠加
		expect(termWeights("笔记 同步").get("note")).toBeGreaterThan(0);
	});

	it("泛词权重的最终封顶：多别名 / 原 query 叠加后仍不超过上限", () => {
		// 逐次注入时的降权挡不住累加：同一个泛词出现在多条别名里，或既来自原 query
		// 又来自别名时，权重会叠加到 cap 之上。这里逐条钉住最终值。
		const CASES: Array<[string, string, number]> = [
			// 「AI 写作」：原 query 的 ai + 别名 `ai writing` 的 ai
			["AI 写作", "ai", PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.ai],
			// 「本地 AI」：原 query 的 ai + `local ai` + `offline ai`
			["本地 AI", "ai", PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.ai],
			// 「向量搜索」：`vector search` + `similarity search`
			["向量搜索", "search", PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.search],
			// 「图片压缩」：`image compression` + `image optimizer`
			["图片压缩", "image", PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.image],
			// 「AI 助手」：原 query 的 ai + `ai assistant`
			["AI 助手", "ai", PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.ai],
			// 「文献管理」：`reference management` + `citation management`
			["文献管理", "management", PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.management],
		];
		for (const [query, term, cap] of CASES) {
			const actual = termWeights(query).get(term);
			expect(actual, `${query} 的 ${term} 未被封顶`).toBe(cap);
		}
	});

	it("封顶只压泛词，不误伤同查询里的精确锚点", () => {
		const writing = termWeights("AI 写作");
		expect(writing.get("ai")).toBe(PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.ai);
		expect(writing.get("writing")).toBe(1);
		expect(writing.get("assistant")).toBe(1);

		const local = termWeights("本地 AI");
		expect(local.get("ai")).toBe(PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS.ai);
		expect(local.get("local")).toBe(1); // local ai + local llm，同一 key 内去重
		expect(local.get("ollama")).toBe(1);
	});

	it("泛词 key 的别名权重不会被平方衰减", () => {
		const terms = termWeights("画布");
		expect(terms.get("canvas")).toBe(PLUGIN_GENERIC_WORD_WEIGHTS.canvas);
		expect(terms.get("whiteboard")).toBe(PLUGIN_GENERIC_WORD_WEIGHTS["画布"]);
		expect(terms.get("freeform")).toBe(PLUGIN_GENERIC_WORD_WEIGHTS["画布"]);
	});

	it("中英混合词一份 key 同时覆盖带空格与不带空格的输入", () => {
		for (const q of ["AI 写作", "AI写作"]) {
			expect(expandQuery(q), q).toContain("ai writing");
			expect(expandQuery(q), q).toContain("writing assistant");
		}
		for (const q of ["PDF 标注", "PDF标注"]) expect(expandQuery(q), q).toContain("pdf annotation");
		for (const q of ["本地 AI", "本地AI"]) expect(expandQuery(q), q).toContain("local llm");
		for (const q of ["Markdown 编辑器", "Markdown编辑器"]) {
			expect(expandQuery(q), q).toContain("markdown editor");
		}
		// 中英混合精确短语同样两种写法都能命中
		expect(findMatchedExactPhrases("PDF 标注")).toEqual(PLUGIN_EXACT_PHRASES["PDF标注"]);
		expect(findMatchedExactPhrases("本地 AI")).toEqual(PLUGIN_EXACT_PHRASES["本地AI"]);
	});

	it("ASCII key 用词边界匹配，不会因子串误命中 email/detail/storage", () => {
		expect(expandQuery("email")).toBe("email");
		expect(expandQuery("detail")).toBe("detail");
		expect(expandQuery("storage")).toBe("storage");
		// 反例：真正的 ASCII 概念词仍能命中
		expect(expandQuery("rag")).toContain("retrieval augmented generation");
		expect(expandQuery("本地 AI")).toContain("ollama");
	});

	it("空 query / 纯空白 query 保持旧行为", () => {
		expect(expandQuery("")).toBe("");
		expect(expandQuery("   ")).toBe("   ");
		expect(expandQueryTerms("")).toEqual([]);
		expect(expandQueryTerms("   ")).toEqual([]);
		expect(findMatchedExactPhrases("")).toEqual([]);
	});

	it("高风险泛词不增加别名数量（分层约束）", () => {
		// 这一层刻意保持最小：别名越多，候选池越不可控
		for (const cn of ["笔记", "链接", "文件", "时间", "图表", "代码", "搜索", "图片", "同步"]) {
			expect(PLUGIN_SYNONYMS[cn].length, `${cn} 的别名数量应保持克制`).toBeLessThanOrEqual(4);
			expect(PLUGIN_GENERIC_WORD_WEIGHTS[cn], `${cn} 应在泛词权重表里`).toBeLessThan(1);
		}
	});
});
