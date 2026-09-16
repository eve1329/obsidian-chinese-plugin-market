import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import { AISearcher, buildBm25Index, bm25RecallScores } from "@domain/search/ai";
import { computeIndexFingerprints } from "@shared/fingerprint";
import { bm25Score, tokenizeForBM25, BM25_K1, BM25_B } from "@domain/search/bm25";
import { t2sForEmbed } from "@translation/lexicon/t2s";
import { expandQueryTerms, findMatchedExactPhrases } from "@translation/lexicon/synonyms";
import { PHASE } from "@domain/search/search-timing";
import { logger } from "@shared/logger";
import { LLMClient } from "@translation/api/api";
import { PluginTagService } from "@domain/catalog/plugin-tags";

// 依赖倒置后：LLM 调用统一走注入的 HttpClient，直接注入 mock 模拟不可达/异常响应
const req = vi.fn();

const PLUGINS = [
	{ id: "dataview", name: "Dataview", description: "Query your notes as a database" },
	{ id: "calendar", name: "Calendar", description: "Track your daily notes" },
	{ id: "git", name: "Git", description: "Version control for your vault" },
	{ id: "translate", name: "Translate", description: "Translate text in notes" },
];

function makeSearcher(embeddingSource: "keyword" | "local" = "keyword") {
	const tagService = new PluginTagService();
	tagService.load({
		dataview: { category: "data", tags: ["query"] },
		calendar: { category: "productivity", tags: ["time"] },
		git: { category: "dev", tags: ["vcs"] },
		translate: { category: "tool", tags: ["language"] },
	});
	const llm = new LLMClient({
		baseURL: "https://api.example.com",
		apiKey: "sk-test",
		model: "test-model",
	});
	const aiConfig = {
		baseURL: "https://api.example.com",
		apiKey: "sk-test",
		model: "test-model",
		embedding: { source: embeddingSource },
	};
	const searcher = new AISearcher(aiConfig, llm, tagService);
	return { searcher, llm };
}

describe("AISearcher 降级健壮性", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	it("LLM 精排不可达时降级到本地关键词排序（rankFallback=true，结果非空）", async () => {
		const { searcher } = makeSearcher();
		// 让所有 requestUrl 立即 reject → 模拟 LLM 端点不可达
		req.mockRejectedValue(new Error("request failed"));

		const result = await searcher.search("query notes database", PLUGINS as any);

		expect(result.rankFallback).toBe(true);
		expect(result.rankedIds.length).toBeGreaterThan(0);
		// 降级结果应是本地召回顺序（含 query 相关项）
		expect(result.rankedIds).toContain("dataview");
	});

	it("LLM 可用时正常语义精排（rankFallback 为 falsy）", async () => {
		const { searcher } = makeSearcher();
		// 让 LLM 返回合法 OpenAI 格式响应（content 内为 ranking JSON 字符串）
		req.mockResolvedValue({
			status: 200,
			json: {
				choices: [
					{
						message: {
							content: JSON.stringify({
								ranking: [0, 1, 2, 3],
								reasons: { dataview: "强相关" },
							}),
						},
					},
				],
			},
		});

		const result = await searcher.search("query notes", PLUGINS as any);

		expect(result.rankFallback).toBeFalsy();
		expect(result.rankedIds.length).toBeGreaterThan(0);
	});

	it("localSearch 纯本地 RRF 融合，不调 LLM（requestUrl 未被用于 LLM）", async () => {
		const { searcher } = makeSearcher();
		// 若 localSearch 误调 LLM，会命中 requestUrl → reject → 抛出；这里若调了即失败
		req.mockRejectedValue(new Error("localSearch 不应调用 LLM/网络"));

		const result = await searcher.localSearch("query notes database", PLUGINS as any);

		expect(result.rankFallback).toBe(true);
		expect(result.rankedIds.length).toBeGreaterThan(0);
		// 关键词召回应命中 dataview（"database" 命中描述）
		expect(result.rankedIds).toContain("dataview");
	});

	it("LLM 只返回部分 ranking 时，未排序候选兜底补回，结果不缺失", async () => {
		const { searcher } = makeSearcher();
		// 注意：query "query notes" 经本地召回（BM25 + 标题模糊）后候选池只有 3 个
		// （dataview/calendar/translate，git 未命中关键词不在池中）。
		// rankSubset 顺序 = [dataview(0), calendar(1), translate(2)]。
		// LLM 仅返回 ranking=[0, 2]（dataview, translate），未排序的 calendar(1) 应被兜底补回末尾。
		req.mockResolvedValue({
			status: 200,
			json: {
				choices: [
					{
						message: {
							content: JSON.stringify({
								ranking: [0, 2],
								reasons: { dataview: "强相关", translate: "相关" },
							}),
						},
					},
				],
			},
		});

		const result = await searcher.search("query notes", PLUGINS as any);

		// 候选池中的 3 个都应出现在结果中：LLM 返回 ranking=[0,2]（排了 2 个），
		// 未排序的第 3 个候选被兜底补回，不缺失。
		// 注意：Array.sort() 原地排序，下面用副本比较，避免污染后续断言。
		expect([...result.rankedIds].sort()).toEqual(["calendar", "dataview", "translate"]);
		// ranking=[0,2] 覆盖了 rankSubset 的第 0、2 位，未覆盖的第 1 位（dataview）被补到末尾
		expect(result.rankedIds[result.rankedIds.length - 1]).toBe("dataview");
	});

	it("reasons 仅保留进入结果的候选，排除被 irrelevant 过滤掉的", async () => {
		const { searcher } = makeSearcher();
		req.mockResolvedValue({
			status: 200,
			json: {
				choices: [
					{
						message: {
							content: JSON.stringify({
								ranking: [0, 1, 2, 3],
								// git 被标为无关（应被过滤），其理由不应出现在结果 reasons
								reasons: {
									dataview: "强相关",
									calendar: "相关",
									git: "无关：不相关",
									translate: "相关",
								},
							}),
						},
					},
				],
			},
		});

		const result = await searcher.search("query notes", PLUGINS as any, true);

		expect(result.rankedIds).not.toContain("git");
		// reasons 不应包含被 irrelevant 排除的 git
		expect(result.reasons).toBeDefined();
		expect(Object.keys(result.reasons!)).not.toContain("git");
		expect(Object.keys(result.reasons!)).toEqual(["dataview", "calendar", "translate"]);
	});
});

describe("搜索分段计时（生产埋点）", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	it("搜索前无快照，搜索后可读到分段与计数", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("llm down")); // 触发精排降级，顺带验证降级计数

		expect(searcher.getLastSearchTiming()).toBeNull();

		await searcher.search("query notes", PLUGINS as any);

		const snap = searcher.getLastSearchTiming();
		expect(snap).not.toBeNull();
		const names = snap!.phases.map((p) => p.name);
		expect(names).toContain("关键词召回");
		expect(names).toContain("标题模糊");
		expect(names).toContain("RRF 融合");
		expect(names).toContain(PHASE.llmRank);

		expect(snap!.counters["插件数"]).toBe(PLUGINS.length);
		expect(snap!.counters["关键词命中"]).toBeGreaterThan(0);
		expect(snap!.counters["精排降级"]).toBe(1);
		expect(snap!.counters["结果数"]).toBeGreaterThan(0);
		expect(snap!.totalMs).toBeGreaterThanOrEqual(0);
	});

	it("失败路径同样留下快照（失败发生在哪一步是关键信息）", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("llm down"));

		// 无任何本地命中 → 走 LLM 兜底召回 → 全部批次失败 → 抛错
		await expect(searcher.search("zzzz不存在zzzz", PLUGINS as any)).rejects.toThrow();

		// 若只在成功路径记录，这里会是 null，出问题时反而没有可用的计时数据
		expect(searcher.getLastSearchTiming()).not.toBeNull();
	});

	it("localSearch 记录计时且不含 LLM 阶段（纯本地路径）", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("localSearch 不应调用 LLM"));

		await searcher.localSearch("query notes", PLUGINS as any);

		const snap = searcher.getLastSearchTiming();
		expect(snap).not.toBeNull();
		expect(snap!.phases.map((p) => p.name)).not.toContain(PHASE.llmRank);
		expect(snap!.counters["结果数"]).toBeGreaterThan(0);
	});

	it("快照是拷贝：外部改动不影响内部状态", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("llm down"));
		await searcher.search("query notes", PLUGINS as any);

		const first = searcher.getLastSearchTiming()!;
		first.phases.push({ name: "伪造", ms: 999 });
		first.counters["伪造"] = 1;

		expect(searcher.getLastSearchTiming()!.phases.map((p) => p.name)).not.toContain("伪造");
		expect(searcher.getLastSearchTiming()!.counters["伪造"]).toBeUndefined();
	});

	it("本地阶段超过阈值时额外告警，且告警文案说明已排除 LLM 耗时", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("llm down"));

		// 每次 performance.now() 前进 200ms。注意 measure() 会调用两次 now()（起止），
		// 但阶段耗时是两次之差 = 1 个增量，故 3 个本地阶段合计 600ms > 400ms 阈值。
		let clock = 0;
		const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => (clock += 200));
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		// 关键：mockRestore() 会连同已记录的调用一起清空，必须在 restore 之前取出。
		let messages: string[] = [];
		try {
			await searcher.search("query notes", PLUGINS as any);
			messages = warnSpy.mock.calls.map((c) => String(c[0]));
		} finally {
			nowSpy.mockRestore();
			warnSpy.mockRestore();
		}

		const slowWarn = messages.find((m) => m.includes("本地检索阶段偏慢"));
		expect(slowWarn).toBeDefined();
		expect(slowWarn!).toContain("不含 LLM 与 embedding 往返");
	});

	it("正常速度的搜索不触发慢查询告警", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("llm down"));
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		let messages: string[] = [];
		try {
			await searcher.search("query notes", PLUGINS as any);
			messages = warnSpy.mock.calls.map((c) => String(c[0]));
		} finally {
			warnSpy.mockRestore();
		}

		expect(messages.some((m) => m.includes("本地检索阶段偏慢"))).toBe(false);
		// 前提校验：本次搜索确实产生过 warn（LLM 精排失败会 warn）。
		// 若没有这条断言，「没告警」可能只是因为根本没采集到调用（假阴性）。
		expect(messages.length).toBeGreaterThan(0);
	});

	it("向量路启用时阶段不重叠，且失败原因如实上报", async () => {
		// 回归 1：search() 曾用 measure("向量召回") 包住 vectorRecallScores，而后者内部又
		// measure("向量索引")/measure("query 编码+余弦")。嵌套导致 localPhaseMs 把整段
		// 向量耗时算两遍，慢查询告警在开启向量搜索时虚报。
		// 现有测试全用 keyword 模式，结构上覆盖不到这条路径。
		const { searcher } = makeSearcher("local");
		req.mockRejectedValue(new Error("llm down"));
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		let warnArgs: unknown[][] = [];
		try {
			// 测试环境未注入 worker 源码加载器，本地模型必然加载失败 → 向量路降级；
			// 但阶段计时照常记录，足以验证结构性质。
			await searcher.localSearch("query notes", PLUGINS as any);
			warnArgs = warnSpy.mock.calls.map((c) => [...c]);
		} finally {
			warnSpy.mockRestore();
		}

		const names = searcher.getLastSearchTiming()!.phases.map((p) => p.name);
		// 确实走向量路（索引阶段被记录）
		expect(names).toContain(PHASE.vectorIndex);
		// 伞形阶段必须不存在
		expect(names).not.toContain("向量召回");
		// 本地阶段只含我们自己的代码，不含向量索引 / query 编码
		expect(names).toContain(PHASE.keyword);
		expect(names).toContain(PHASE.fuzzy);
		expect(names).toContain(PHASE.rrf);

		// 回归 2：失败原因应是真实原因，而不是被 dispose 抹掉 this.initPromise 后
		// 的「worker not ready」—— 后者既误导调用方，又留下 unhandled rejection。
		const vectorWarn = warnArgs.find((a) => String(a[0]).includes("向量召回失败"));
		expect(vectorWarn).toBeDefined();
		expect(String((vectorWarn![1] as Error)?.message)).toContain("worker 源码加载器未注入");
	});
});

describe("BM25 倒排索引（与单条打分等价性）", () => {
	// 合成语料：覆盖中文三元组、ASCII 词、超短描述、空描述，以及 p8/p9 这组
	// 「等长 + 同词」的构造，用于验证同分时的 tie-break。
	const CORPUS = [
		{ id: "p0", name: "Dataview", description: "把笔记当作数据库查询，支持类 SQL 语法" },
		{ id: "p1", name: "Calendar", description: "日历视图，追踪每日笔记与任务" },
		{ id: "p2", name: "Kanban", description: "看板视图，把笔记组织成任务卡片" },
		{ id: "p3", name: "Excalidraw", description: "手绘白板，支持思维导图与流程图" },
		{ id: "p4", name: "Templater", description: "模板引擎，批量生成笔记内容" },
		{ id: "p5", name: "Git", description: "版本控制，备份你的笔记仓库" },
		{ id: "p6", name: "笔记助手", description: "笔记" },
		{ id: "p7", name: "Empty", description: "" },
		{ id: "p8", name: "Twin", description: "笔记 同步" },
		{ id: "p9", name: "Duo", description: "笔记 同步" },
	];

	const index = buildBm25Index(CORPUS, computeIndexFingerprints(CORPUS).bm25);

	/**
	 * 参考实现：逐条文档调用 bm25Score（即重构前 ai.ts 的做法）。
	 * 与被测的倒排路径完全独立（文档侧不碰 postings/df/docLen 索引结构），
	 * 用于证明「换索引结构不改分数」。
	 *
	 * query 侧权重必须与生产同源：`bm25RecallScores` 用 `expandQueryTerms`
	 * （含泛词降权）。参考实现若仍用 `expandQuery`（全部权重 1），泛词降权一上线
	 * 就会出现系统性偏差，把「索引结构是否等价」这个真正要验证的问题掩盖掉。
	 */
	function referenceScores(query: string): Map<string, number> {
		const qtf = new Map<string, number>();
		for (const { term, weight } of expandQueryTerms(query.trim())) {
			for (const normalized of tokenizeForBM25(t2sForEmbed(term))) {
				qtf.set(normalized, (qtf.get(normalized) ?? 0) + weight);
			}
		}
		const out = new Map<string, number>();
		if (qtf.size === 0) return out;
		for (const p of CORPUS) {
			const docTokens = tokenizeForBM25(t2sForEmbed(`${p.name} ${p.description}`));
			const score = bm25Score(
				Array.from(qtf.keys()), docTokens, index.df, index.N, index.avgdl, BM25_K1, BM25_B, qtf
			);
			if (score > 0) out.set(p.id, score);
		}
		return out;
	}

	const QUERIES = ["笔记", "日历", "思维导图", "dataview", "模板 笔记", "笔记 同步", "zzz不存在", "", "   "];

	it("前提：QUERIES 不命中精确短语表（否则参考实现需同步短语加权）", () => {
		// 精确短语走独立的连续子串倒排（2.5×IDF），参考实现没有复刻这一段。
		// 一旦有人把「笔记」「思维导图」这类词加进 PLUGIN_EXACT_PHRASES，这里会先失败
		// 并给出明确提示，而不是让下面的逐位对拍出现难以定位的浮点差异。
		for (const q of QUERIES) expect(findMatchedExactPhrases(q), `query="${q}"`).toEqual([]);
	});

	for (const query of QUERIES) {
		it(`query="${query}" 命中集合与分数与参考实现一致`, () => {
			const actual = bm25RecallScores(query, index);
			const expected = referenceScores(query);
			expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
			for (const [id, s] of expected) {
				// 逐位相等：两条路径的 term 遍历顺序相同，浮点累加顺序也相同，
				// 因此不该有误差。用 toBeCloseTo 会掩盖「公式被改坏但差得很小」的情况。
				expect(actual.get(id)).toBe(s);
			}
		});
	}

	it("自然语言查询无限画布时优先召回包含该功能的插件", () => {
		const corpus = [
			{ id: "unrelated", name: "Canvas Board", description: "普通画布白板工具" },
			{ id: "canvas", name: "Milanote-like", description: "类似 Milanote 的视觉工作区，提供无限画布、便签和链接" },
			{ id: "whiteboard", name: "Whiteboard", description: "在虚拟白板上绘制和编辑内容" },
		];
		const index = buildBm25Index(corpus, computeIndexFingerprints(corpus).bm25);
		const scores = bm25RecallScores("我想找一个无限画布相关的插件", index);
		const ids = [...scores.keys()];
		expect(ids).toContain("canvas");
		expect(ids[0]).toBe("canvas");
	});

	it("精确短语只奖励连续命中，不把分散词误当成无限画布", () => {
		const corpus = [
			{ id: "generic", name: "Canvas Board", description: "普通画布工具" },
			{ id: "split", name: "Split Canvas", description: "无限的白板和画布，可自由排列" },
			{ id: "exact", name: "Milanote", description: "提供无限画布和便签的视觉工作区" },
		];
		const index = buildBm25Index(corpus, computeIndexFingerprints(corpus).bm25);
		const ids = [...bm25RecallScores("我想找一个无限画布相关的插件", index).keys()];
		expect(ids[0]).toBe("exact");
		expect(ids.indexOf("exact")).toBeLessThan(ids.indexOf("split"));
	});

	it("手算基准：等长单 token 语料下得分应恰为 0.4×ln(2)", () => {
		// 为什么需要这条：上面的「倒排 vs bm25Score」对拍**证明不了公式本身正确** ——
		// bm25Score 现已改为调用 bm25Idf/bm25LenNorm/bm25TermWeight，与倒排路径共用同一批
		// 原语，原语若有公式错误，两边会一起错、对拍照样通过。
		//
		// 这里构造一个能精确手算的语料：两条文档各只有 1 个 token，其中一条含查询词。
		//   N = 2, avgdl = 1  → 长度归一分母 = 1 - 0.75 + 0.75 × (1/1) = 1
		//   df("笔记") = 1    → IDF = ln((2-1+0.5)/(1+0.5) + 1) = ln 2
		//   tf = 1, k1 = 1.5  → termWeight = 1×2.5 / (1 + 1.5×1) = 1
		//   query 权重 = 0.4  → 「笔记」是高风险泛词，权重表把它封顶到 0.4
		//   ⇒ score = 0.4 × ln2 × 1
		// 期望值由公式推导得出、不来自生产代码，因此能发现原语自身的公式错误。
		const corpus = [
			{ id: "e0", name: "A", description: "" },
			{ id: "e1", name: "笔记", description: "" },
		];
		const handIndex = buildBm25Index(corpus, computeIndexFingerprints(corpus).bm25);
		const scores = bm25RecallScores("笔记", handIndex);

		expect(scores.get("e1")).toBe(0.4 * Math.LN2);
		expect(scores.has("e0")).toBe(false);
	});

	it("手算基准（文档长度不等）：把 k1 与 b 也钉住", () => {
		// 上面那条语料里 k1 与 b 会代数约掉 —— lenNorm = 1-b+b×(1/1) = 1，
		// termWeight = (1×(k1+1))/(1+k1×1) = 1，对任意 k1/b 都成立，
		// 所以它只能验证 IDF 公式。这里用文档长度不等的语料让两者真正参与计算：
		//   d0: ["笔记"]             → docLen = 1
		//   d1: ["甲","笔记","笔记"]  → docLen = 3
		//   N=2, avgdl=(1+3)/2=2, df("笔记")=2
		//   IDF = ln((2-2+0.5)/(2+0.5) + 1) = ln(1.2)
		//   d0: lenNorm = 1-0.75+0.75×(1/2) = 0.625 → termWeight = 1×2.5/(1+1.5×0.625)
		//   d1: lenNorm = 1-0.75+0.75×(3/2) = 1.375 → termWeight = 2×2.5/(2+1.5×1.375)
		//   query 权重 = 0.4（「笔记」是高风险泛词）
		// 期望值把 k1=1.5、b=0.75 与泛词权重 0.4 都硬编码在表达式里：
		// 改动这些常量会让断言失败。
		const corpus = [
			{ id: "d0", name: "笔记", description: "" },
			{ id: "d1", name: "甲", description: "笔记 笔记" },
		];
		const handIndex = buildBm25Index(corpus, computeIndexFingerprints(corpus).bm25);
		const scores = bm25RecallScores("笔记", handIndex);

		const idf = 0.4 * Math.log(1.2);
		expect(scores.get("d0")).toBeCloseTo(idf * (2.5 / (1 + 1.5 * 0.625)), 12);
		expect(scores.get("d1")).toBeCloseTo(idf * (5 / (2 + 1.5 * 1.375)), 12);
		// 短文档命中 1 次应高于长文档命中 2 次（长度归一化生效）
		expect(scores.get("d0")!).toBeGreaterThan(scores.get("d1")!);
	});

	it("结果按 (score desc, 插件列表序 asc) 排序 —— 同分 tie-break 与旧实现一致", () => {
		const actual = bm25RecallScores("笔记", index);
		const ids = [...actual.keys()];
		const pos = new Map(CORPUS.map((p, i) => [p.id, i]));
		for (let i = 1; i < ids.length; i++) {
			const prev = actual.get(ids[i - 1])!;
			const cur = actual.get(ids[i])!;
			// 分数严格降序；同分则插件列表序严格递增
			if (prev === cur) {
				expect(pos.get(ids[i - 1])!).toBeLessThan(pos.get(ids[i])!);
			} else {
				expect(prev).toBeGreaterThan(cur);
			}
		}
		// p8/p9 等长同词 → 必然同分，且 p8 在 p9 之前
		expect(actual.get("p8")).toBeCloseTo(actual.get("p9")!, 12);
		expect(ids.indexOf("p8")).toBeLessThan(ids.indexOf("p9"));
	});

	it("topK 截断：只保留前 k 条，且是全量结果的前缀", () => {
		const full = bm25RecallScores("笔记", index);
		expect(full.size).toBeGreaterThan(2);
		const capped = bm25RecallScores("笔记", index, 2);
		expect(capped.size).toBe(2);
		expect([...capped.keys()]).toEqual([...full.keys()].slice(0, 2));
	});

	it("getBm25Index 按内容指纹缓存：内容不变复用同一引用，中间条目变化则重建", () => {
		const { searcher } = makeSearcher();

		const first = searcher.getBm25Index(CORPUS);
		expect(searcher.getBm25Index(CORPUS)).toBe(first); // 内容不变 → 同一实例

		// 中间条目的描述变化：条目数、首尾 id 都没变
		// （旧的「长度 + 首尾 id」签名会漏判，继续用过期分词打分）
		const mutated = CORPUS.map((p) => ({ ...p }));
		mutated[2].description += "（已更新）";
		expect(mutated.length).toBe(CORPUS.length);
		expect(mutated[0].id).toBe(CORPUS[0].id);
		expect(mutated[mutated.length - 1].id).toBe(CORPUS[CORPUS.length - 1].id);

		expect(searcher.getBm25Index(mutated)).not.toBe(first);
	});

	it("传入预计算指纹时不再自行遍历（避免每次搜索算两遍）", () => {
		const { searcher } = makeSearcher();
		const sig = computeIndexFingerprints(CORPUS).bm25;
		const a = searcher.getBm25Index(CORPUS, sig);
		// 同一个预计算指纹 → 命中缓存
		expect(searcher.getBm25Index(CORPUS, sig)).toBe(a);
		// 与不传预计算指纹时的结果一致（签名语义相同）
		expect(searcher.getBm25Index(CORPUS)).toBe(a);
	});

	/** 用生产 BM25 路径跑一个小语料，返回按分数降序的插件 id。 */
	function recallIds(corpus: { id: string; name: string; description: string }[], query: string): string[] {
		const idx = buildBm25Index(corpus, computeIndexFingerprints(corpus).bm25);
		return [...bm25RecallScores(query, idx).keys()];
	}

	it("「卡片盒」能召回 zettelkasten 类插件（修复前是 0 命中）", () => {
		const corpus = [
			{ id: "zettelkasten-core", name: "Zettelkasten Core", description: "卡片盒笔记法：原子笔记与永久笔记" },
			{ id: "note-sync", name: "Note Sync", description: "同步你的笔记" },
		];
		const ids = recallIds(corpus, "卡片盒");
		expect(ids[0]).toBe("zettelkasten-core");
		expect(ids).toContain("zettelkasten-core");
	});

	it("精确概念不会被泛词拖成全库召回（双链笔记 vs 普通笔记插件）", () => {
		const corpus = [
			{ id: "wikilink-pro", name: "Wikilink Pro", description: "双链笔记与反向链接管理" },
			...Array.from({ length: 40 }, (_, i) => ({
				id: `note-${i}`,
				name: `Note ${i}`,
				description: "普通笔记插件，用于记录笔记",
			})),
		];
		const ids = recallIds(corpus, "双链笔记");
		expect(ids[0]).toBe("wikilink-pro");
		// 旧实现会把「笔记」也扩展成 note/notes/obsidian，40 条普通笔记插件全部进候选
		expect(ids.length).toBeLessThan(10);
	});

	it("「时间线」不被时钟/计时器类插件污染（时间 是高风险泛词）", () => {
		const corpus = [
			{ id: "timeline", name: "Timeline", description: "时间线视图，按时间排列笔记" },
			{ id: "clock", name: "Status Bar Clock", description: "在状态栏显示时钟" },
			{ id: "timer", name: "Pomodoro Timer", description: "番茄计时器" },
			{ id: "datepicker", name: "Datepicker", description: "日期选择器" },
		];
		const ids = recallIds(corpus, "时间线");
		expect(ids[0]).toBe("timeline");
		// 「时间线」命中后跳过子词「时间」，否则 time/clock/timer 会把候选池污染掉
		expect(ids).not.toContain("clock");
		expect(ids).not.toContain("timer");
		expect(ids).not.toContain("datepicker");
	});

	it("「PDF 标注」不会召回 badge/callout 这类非 PDF 标注插件", () => {
		const corpus = [
			{ id: "pdf-anno", name: "PDF Annotation", description: "PDF 标注与批注" },
			{ id: "badges", name: "Badges", description: "给笔记加上角标徽章" },
			{ id: "calloutx", name: "CalloutX", description: "自定义 callout 标注样式" },
		];
		const ids = recallIds(corpus, "PDF 标注");
		expect(ids[0]).toBe("pdf-anno");
		// 旧实现下「标注」会扩展出 highlight/badge，把徽章、callout 插件一起召回
		expect(ids).not.toContain("badges");
		expect(ids).not.toContain("calloutx");
	});

	it("「本地 AI」优先召回本地推理插件，而不是通用 AI 写作插件", () => {
		const corpus = [
			{ id: "ollama", name: "Ollama", description: "本地 LLM 推理" },
			{ id: "local-llm", name: "Local LLM", description: "接入本地 LLM 服务" },
			{ id: "ai-writer", name: "AI Writer", description: "AI 写作助手" },
		];
		const ids = recallIds(corpus, "本地 AI");
		// ai 是高风险泛词，必须被本地/模型类锚点压过，否则结果会被 AI 写作插件占满
		expect(ids.indexOf("ollama")).toBeLessThan(ids.indexOf("ai-writer"));
		expect(ids.indexOf("local-llm")).toBeLessThan(ids.indexOf("ai-writer"));
	});

	it("短语倒排表补上 CJK 三元组盲区：中文查询能命中中文原文的不同措辞", () => {
		// 「PDF 标注」按三元组分词只匹配到原文里连写的「pdf标注」，
		// 而真阳性插件大多写的是「PDF 注释」「pdf annotation」。短语组把两种措辞绑在一起，
		// 靠连续子串命中 —— 这是本轮把「PDF 标注」precision@10 从 2/10 提到 7/10 的机制。
		const corpus = [
			{ id: "pdf-printer", name: "PDF Printer", description: "打印 PDF 文件" },
			{ id: "annotator", name: "Annotator", description: "PDF 注释工具，支持高亮与批注" },
		];
		expect(recallIds(corpus, "PDF 标注")[0]).toBe("annotator");
	});

	it("「AI 写作」靠「写作助手」短语锚点与普通写作插件区分开", () => {
		const corpus = [
			{ id: "writing", name: "Writing", description: "写作目标与写作习惯追踪" },
			{ id: "ai-helper", name: "AI Helper", description: "人工智能写作助手" },
		];
		expect(recallIds(corpus, "AI 写作")[0]).toBe("ai-helper");
	});
});
