/**
 * 冻结基线：本轮「中文功能词表扩充」**改动前**的 `src/translation/lexicon/synonyms.ts`。
 *
 * 为什么要把一份旧文件放进仓库：复核要求「保存可复现的修复前 baseline」。
 * 本轮改动开始前，工作区里已经带着上一轮（AI 语义检索修复）的未提交改动，
 * 因此 `git show HEAD:src/translation/lexicon/synonyms.ts` **不是**本轮的正确基线 ——
 * 只有这里冻结的副本能让第三方逐位复现报告里的「修复前」列。
 *
 * 用法（不改工作区源码，靠 esbuild 别名把它替换进评估 bundle）：
 *   pnpm eval:recall:baseline
 * 等价命令：
 *   esbuild scripts/eval-synonym-recall.ts --bundle --platform=node --format=esm \
 *     --external:obsidian --external:sql.js --external:@huggingface/transformers \
 *     --alias:@domain=./src/domain --alias:@translation=./src/translation \
 *     --alias:@shared=./src/shared --alias:@semantic=./src/semantic \
 *     --alias:@data=./src/data --alias:@app=./src/app --alias:@ui=./src/ui \
 *     --alias:@translation/lexicon/synonyms=./scripts/baselines/synonyms.pre-round.ts \
 *     --outfile=scripts/eval-synonym-recall.baseline.mjs
 *   node scripts/eval-synonym-recall.baseline.mjs --acceptance
 *
 * ⚠️ 这是**只读的历史快照**，不参与生产构建，也不要在这里改词表 —— 改动请改
 * `src/translation/lexicon/synonyms.ts`。别名替换必须写在 `--alias:@translation=...` 之后才生效。
 */

/** 常见插件领域同义词（中文词 → 英文别名列表）。key 为中文词，value 为别名。 */
export const PLUGIN_SYNONYMS: Record<string, string[]> = {
	"思维导图": ["mind map", "mindmap", "markmap", "map"],
	"画布": ["canvas", "infinite canvas", "whiteboard", "freeform canvas"],
	"无限画布": ["infinite canvas", "infinite whiteboard", "freeform canvas"],
	"白板": ["whiteboard", "canvas", "infinite canvas", "freeform"],
	"流程图": ["flowchart", "flow chart", "diagram", "mermaid"],
	"笔记": ["note", "notes", "obsidian"],
	"同步": ["sync", "syncing"],
	"看板": ["kanban"],
	"日历": ["calendar"],
	"番茄": ["pomodoro", "tomato", "focus"],
	"番茄钟": ["pomodoro"],
	"待办": ["todo", "task", "checklist"],
	"任务": ["task", "todo"],
	"清单": ["list", "checklist", "todo"],
	"表格": ["table", "database", "spreadsheet"],
	"数据库": ["database", "db", "sql"],
	"文件夹": ["folder", "directory"],
	"标签": ["tag", "tags"],
	"标签管理": ["tag", "tagging"],
	"关系图": ["graph", "graph view"],
	"图谱": ["graph", "graph view"],
	"日记": ["daily", "journal", "diary"],
	"周记": ["weekly", "journal"],
	"模板": ["template", "templater"],
	"引用": ["citation", "quote", "bibtex"],
	"文献": ["citation", "reference", "bibtex"],
	"搜索": ["search", "find"],
	"高亮": ["highlight", "mark"],
	"标注": ["highlight", "annotation", "annotate"],
	"翻译": ["translate", "translation"],
	"朗读": ["tts", "read", "speech"],
	"录音": ["record", "recording", "audio"],
	"语音": ["speech", "tts", "audio"],
	"图片": ["image", "img", "attachment"],
	"图片粘贴": ["paste", "image"],
	"附件": ["attachment", "file"],
	"文件": ["file", "attachment"],
	"网页": ["web", "page", "url"],
	"网页剪藏": ["clipper", "web", "save"],
	"剪藏": ["clipper", "web clipper"],
	"代码": ["code", "codeblock", "coder"],
	"编程": ["code", "developer"],
	"开发": ["developer", "dev", "code"],
	"导出": ["export", "pdf", "html"],
	"导入": ["import", "importing"],
	"发布": ["publish", "deploy", "share"],
	"分享": ["share", "publish"],
	"链接": ["link", "wikilink", "url"],
	"双链": ["wikilink", "backlink", "link"],
	"反链": ["backlink", "link"],
	"思维": ["thinking", "thought"],
	"AI": ["ai", "gpt", "llm", "openai"],
	"人工智能": ["ai", "gpt", "llm"],
	"统计": ["statistics", "stats", "count"],
	"图表": ["chart", "graph", "plot"],
	"图表分析": ["chart", "charting"],
	"数据分析": ["data", "analysis", "analytics"],
	"分析": ["analysis", "analytics", "stats"],
	"学习": ["learning", "study", "spaced repetition"],
	"间隔重复": ["spaced repetition", "anki", "srs"],
	"记忆": ["memory", "spaced repetition", "anki"],
	"写作": ["writing", "writer"],
	"编辑器": ["editor", "edit"],
	"预览": ["preview", "view"],
	"样式": ["style", "css", "theme"],
	"主题": ["theme", "css", "style"],
	"字体": ["font", "type"],
	"图床": ["image", "upload", "picgo"],
	"上传": ["upload", "image"],
	"备份": ["backup", "sync"],
	"版本": ["version", "git"],
	"版本控制": ["git", "version control"],
	"历史": ["history", "revision", "undo"],
	"恢复": ["recover", "restore", "undo"],
	"撤销": ["undo", "history"],
	"快捷键": ["hotkey", "shortcut", "keyboard"],
	"命令": ["command", "palette", "cmd"],
	"文件夹导航": ["file", "explorer", "navigation"],
	"导航": ["navigation", "nav", "breadcrumb"],
	"书签": ["bookmark", "favorite"],
	"收藏": ["favorite", "bookmark", "star"],
	"悬浮": ["hover", "popup", "preview"],
	"预览窗口": ["hover", "popup", "preview"],
	"阅读模式": ["reading", "read"],
	"编辑模式": ["source", "edit"],
	"密码": ["password", "encrypt", "lock"],
	"加密": ["encrypt", "encryption", "password"],
	"隐私": ["privacy", "encrypt"],
	"中文": ["chinese", "zh", "cn"],
	"英文": ["english", "en"],
	"拼写": ["spell", "spelling", "grammar"],
	"语法": ["grammar", "spell"],
	"校对": ["proofread", "grammar", "spell"],
	"摘录": ["excerpt", "quote", "highlight"],
	"摘要": ["summary", "summarize"],
	"字数": ["word count", "count", "stats"],
	"字数统计": ["word count", "count"],
	"滚动": ["scroll", "scrollbar"],
	"折叠": ["collapse", "fold"],
	"大纲": ["outline", "toc", "heading"],
	"目录": ["toc", "outline", "table of contents"],
	"标题": ["heading", "header", "h1"],
	"分割线": ["divider", "hr", "separator"],
	"代码高亮": ["highlight", "syntax", "code"],
	"语法高亮": ["syntax highlight", "highlight"],
	"图标": ["icon", "emoji"],
	"表情": ["emoji", "icon"],
	"角标": ["badge", "count"],
	"进度": ["progress", "bar"],
	"习惯": ["habit", "tracker"],
	"习惯追踪": ["habit tracker", "tracker"],
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
	"时区": ["timezone", "time"],
	"时间": ["time", "clock", "timer"],
	"日期": ["date", "day"],
	"年龄": ["age", "birthday"],
	"名字": ["name", "naming"],
	"命名": ["naming", "name"],
	"邮箱": ["email", "mail"],
	"邮件": ["email", "mail"],
	"微信": ["wechat", "weixin"],
	"浏览器": ["browser", "web"],
	"剪贴板": ["clipboard", "paste"],
	"复制": ["copy", "clipboard"],
	"剪切": ["cut", "clipboard"],
	"粘贴": ["paste", "clipboard"],
};

/**
 * 需要作为一个概念处理的短语。
 *
 * `PLUGIN_SYNONYMS` 保持原有的 string[] 形状，避免已有调用方失效；这里单独
 * 存放短语元数据，让 BM25 可以提高「无限画布」这类长词的权重，而不必把所有
 * 同义词都改成对象。值中包含中文原词和应优先命中的英文短语。
 */
export const PLUGIN_EXACT_PHRASES: Record<string, string[]> = {
	"无限画布": ["无限画布", "infinite canvas", "infinite whiteboard", "freeform canvas"],
	"图片粘贴": ["图片粘贴", "image paste"],
	"网页剪藏": ["网页剪藏", "web clipper"],
	"代码高亮": ["代码高亮", "code highlight", "syntax highlight"],
	"字数统计": ["字数统计", "word count"],
	"习惯追踪": ["习惯追踪", "habit tracker"],
	"间隔重复": ["间隔重复", "spaced repetition"],
	"版本控制": ["版本控制", "version control"],
	"文件夹导航": ["文件夹导航", "folder navigation"],
	"预览窗口": ["预览窗口", "preview window"],
};

/**
 * 泛词在同义词扩展中的相对权重（0~1）。
 *
 * 泛词仍然保留召回能力，只是不能压过同时命中精确短语的文档。权重只作用于
 * 查询侧，不改变文档长度归一化，也不会让已有的普通关键词查询完全失效。
 */
export const PLUGIN_GENERIC_WORD_WEIGHTS: Record<string, number> = {
	"画布": 0.35,
	"白板": 0.4,
	canvas: 0.35,
	whiteboard: 0.4,
	freeform: 0.35,
};

/** 查询词及其相对权重，供 BM25 倒排召回使用。 */
export interface ExpandedQueryTerm {
	term: string;
	weight: number;
}

/** 对文本分词并累加 query term 权重。 */
function addWeightedText(target: Map<string, number>, text: string, weight: number): void {
	if (!text || weight <= 0) return;
	for (const term of tokenizeForExpansion(text)) {
		target.set(term, (target.get(term) ?? 0) + weight);
	}
}

/** 对已存在的 token 权重整体缩放（用于原查询中直接输入的泛词）。 */
function scaleWeightedText(target: Map<string, number>, text: string, factor: number): void {
	for (const term of tokenizeForExpansion(text)) {
		const current = target.get(term);
		if (current !== undefined) target.set(term, current * factor);
	}
}

/** 将泛词别名的重复注入限制在一个权重内，避免同一泛词出现在多个短语别名中时叠加。 */
function capWeightedText(target: Map<string, number>, text: string, maxWeight: number): void {
	for (const term of tokenizeForExpansion(text)) {
		const current = target.get(term);
		if (current !== undefined) target.set(term, Math.min(current, maxWeight));
	}
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
	const q = query.toLowerCase();
	const weights = new Map<string, number>();
	addWeightedText(weights, query, 1);
	// ASCII 泛词不一定是 PLUGIN_SYNONYMS 的 key（例如用户直接输入 canvas），
	// 先处理原 query，保证它和中文泛词一样降权。
	for (const [word, weight] of Object.entries(PLUGIN_GENERIC_WORD_WEIGHTS)) {
		if (isAsciiKey(word) && getAsciiKeyRegex(word).test(q)) scaleWeightedText(weights, word, weight);
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
			// 也降权，避免只降别名却仍让原词以满权重参与排序。
			scaleWeightedText(weights, cn, genericKeyWeight);
		}
		if (!standalone) {
			addWeightedText(weights, cn, genericKeyWeight);
		}

		for (const alias of aliases) {
			const aliasKey = alias.toLowerCase();
			const aliasWeight = isGenericKey
				? genericKeyWeight
				: (PLUGIN_GENERIC_WORD_WEIGHTS[aliasKey] ?? 1);
			addWeightedText(weights, alias, aliasWeight);
			if (isGenericKey) capWeightedText(weights, alias, genericKeyWeight);
		}
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
	const q = query.toLowerCase();
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
	const q = query.toLowerCase();
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
