import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import {
	buildVectorIndex,
	vectorRecall,
	ApiEmbeddingProvider,
	LocalEmbeddingProvider,
	DEFAULT_LOCAL_MODEL,
	getEmbeddingIdentity,
	__clearQueryVecCacheForTest,
	type EmbeddingProvider,
	type VectorIndex,
	type LocalModelBackend,
} from "@semantic/embedding";
import { Translator } from "@domain/catalog/translator";

// PERF-9：模块级 query embedding 缓存在测试间会泄漏状态，每个测试前清空。
beforeEach(() => {
	__clearQueryVecCacheForTest();
});

/** 可注入的 FakeBackend：记录调用、可模拟失败，无需真实下载模型。 */
function makeFakeBackend(opts?: {
	throwOnEmbed?: boolean;
	dim?: number;
}): LocalModelBackend & { calls: number[] } {
	const dim = opts?.dim ?? 3;
	return {
		name: "fake",
		calls: 0 as unknown as number[],
		async embed(texts: string[]): Promise<number[][]> {
			this.calls++;
			if (opts?.throwOnEmbed) throw new Error("backend boom");
			// 确定性的伪向量：每个字符码值映射到坐标，便于断言顺序
			return texts.map((t, i) => [
				((t.length + i) % dim) / dim,
				1 - ((t.length + i) % dim) / dim,
				0.5,
			]);
		},
	};
}

/** 内存 mock provider：把文本映射成确定性向量，避免真实网络调用。 */
function makeMockProvider(
	map: Record<string, number[]>,
	fallbackDim = 3
): EmbeddingProvider & { calls: number } {
	const provider = {
		name: "mock",
		calls: 0,
		async embed(texts: string[]): Promise<number[][]> {
			this.calls++;
			return texts.map(
				(t) => map[t] ?? new Array(fallbackDim).fill(0)
			);
		},
	};
	return provider;
}

	const plugins = [
	{ id: "sync", name: "Sync", description: "keep notes in sync across devices" },
	{ id: "theme", name: "Theme", description: "beautiful color themes" },
	{ id: "kanban", name: "Kanban", description: "task board" },
];

describe("buildVectorIndex", () => {
	it("首次构建：调用 provider.embed 并返回 ids/vectors/hash/model", async () => {
		const provider = makeMockProvider({});
		const idx = await buildVectorIndex(provider, plugins, "m1");
		expect(idx.ids).toEqual(["sync", "theme", "kanban"]);
		expect(idx.vectors.length).toBe(3);
		expect(idx.model).toBe("m1");
		expect(typeof idx.hash).toBe("string");
		expect(provider.calls).toBe(1);
	});

	it("内容 + 模型未变：复用 prevIndex，不再调用 embed", async () => {
		const provider = makeMockProvider({});
		const first = await buildVectorIndex(provider, plugins, "m1");
		const second = await buildVectorIndex(provider, plugins, "m1", first);
		expect(second).toBe(first);
		expect(provider.calls).toBe(1); // 未新增调用
	});

	it("模型变化：即使内容相同也重建", async () => {
		const provider = makeMockProvider({});
		const first = await buildVectorIndex(provider, plugins, "m1");
		const second = await buildVectorIndex(provider, plugins, "m2", first);
		expect(second).not.toBe(first);
		expect(second.model).toBe("m2");
		expect(provider.calls).toBe(2);
	});

	it("内容变化：重建", async () => {
		const provider = makeMockProvider({});
		const first = await buildVectorIndex(provider, plugins, "m1");
		const changed = [...plugins, { id: "new", name: "New", description: "x" }];
		const second = await buildVectorIndex(provider, changed, "m1", first);
		expect(second).not.toBe(first);
		expect(second.ids).toContain("new");
		expect(provider.calls).toBe(2);
	});

	it("embedding 身份变化：同模型换 endpoint 也必须重建", async () => {
		const provider = makeMockProvider({});
		const identityA = getEmbeddingIdentity({ source: "api", baseURL: "https://a.example", model: "m1" });
		const identityB = getEmbeddingIdentity({ source: "api", baseURL: "https://b.example", model: "m1" });
		const first = await buildVectorIndex(provider, plugins, "m1", undefined, undefined, undefined, identityA);
		const second = await buildVectorIndex(provider, plugins, "m1", first, undefined, undefined, identityB);
		expect(second).not.toBe(first);
		expect(second.embeddingIdentity).toBe(identityB);
		expect(provider.calls).toBe(2);
	});

	it("旧持久化索引缺 fieldsHash：整体 hash 相同只回填指纹，不重新 embed", async () => {
		const providerA = makeMockProvider({});
		const built = await buildVectorIndex(providerA, plugins, "m1");
		const persisted = { ...built };
		delete persisted.fieldsHash;

		const providerB = makeMockProvider({});
		const reused = await buildVectorIndex(providerB, plugins, "m1", persisted);
		expect(reused).toBe(persisted);
		expect(providerB.calls).toBe(0);
		expect(reused.fieldsHash).toBe(built.fieldsHash);
	});
});

describe("buildVectorIndex · 用法 A：分类维度注入（召回信号）", () => {
	const tagged = [
		{ id: "sync", name: "Sync", description: "keep notes in sync", category: "同步与备份", tags: ["同步", "云盘"] },
		{ id: "theme", name: "Theme", description: "color themes", category: "外观与主题", tags: ["美化"] },
		{ id: "kanban", name: "Kanban", description: "task board", category: "任务与项目", tags: ["看板"] },
	];

	it("category 作为强锚点放在句首，tags 尾随（文本含「分类：」与「标签：」）", async () => {
		const captured: string[] = [];
		const provider: EmbeddingProvider = {
			name: "cap",
			async embed(texts) {
				captured.push(...texts);
				return texts.map(() => [0, 0, 0]);
			},
		};
		await buildVectorIndex(provider, tagged, "m1");
		expect(captured[0]).toContain("分类：同步与备份");
		expect(captured[0]).toContain("标签：同步 云盘");
		// 句首应为「分类：」前缀（强锚点先于 name/description）
		expect(captured[0].startsWith("分类：同步与备份")).toBe(true);
	});

	it("无 category/tags 时退化为旧格式（仅 name + description），向后兼容", async () => {
		const captured: string[] = [];
		const provider: EmbeddingProvider = {
			name: "cap",
			async embed(texts) {
				captured.push(...texts);
				return texts.map(() => [0, 0, 0]);
			},
		};
		await buildVectorIndex(provider, plugins, "m1");
		expect(captured[0]).toBe("Sync\nkeep notes in sync across devices");
		expect(captured[0]).not.toContain("分类：");
		expect(captured[0]).not.toContain("标签：");
	});

	it("categorySchemaVersion 变化 → 即使 texts/hash/category 文本相同也强制重建", async () => {
		const provider = makeMockProvider({});
		const first = await buildVectorIndex(provider, tagged, "m1", undefined, "v1");
		// 相同 plugins + 相同版本 → 复用
		const second = await buildVectorIndex(provider, tagged, "m1", first, "v1");
		expect(second).toBe(first);
		expect(provider.calls).toBe(1);
		// 版本号变化 → 强制重建（护栏：分类体系大改但文本指纹巧合相同）
		const third = await buildVectorIndex(provider, tagged, "m1", first, "v2");
		expect(third).not.toBe(first);
		expect(third.categorySchemaVersion).toBe("v2");
		expect(provider.calls).toBe(2);
	});

	it("返回的索引记录 categorySchemaVersion 字段", async () => {
		const provider = makeMockProvider({});
		const idx = await buildVectorIndex(provider, tagged, "m1", undefined, "v3");
		expect(idx.categorySchemaVersion).toBe("v3");
	});

	it("分类体系版本号缺失（undefined）时也能正常构建与复用", async () => {
		const provider = makeMockProvider({});
		const first = await buildVectorIndex(provider, tagged, "m1");
		const second = await buildVectorIndex(provider, tagged, "m1", first);
		expect(second).toBe(first);
		expect(second.categorySchemaVersion).toBeUndefined();
	});
});

describe("vectorRecall", () => {
	const index: VectorIndex = {
		ids: ["sync", "theme", "kanban"],
		vectors: [
			[1, 0, 0], // sync
			[0, 1, 0], // theme
			[0, 0, 1], // kanban
		],
		hash: "h",
		model: "m1",
	};

	it("query 向量与 sync 同向 → sync 排第一", async () => {
		const provider = makeMockProvider({ "同步": [1, 0, 0] });
		const out = await vectorRecall(provider, "同步", index, 2);
		expect(out[0]).toBe("sync");
		expect(out.length).toBe(2);
	});

	it("query 向量与 theme 同向 → theme 排第一", async () => {
		const provider = makeMockProvider({ q: [0, 1, 0] });
		const out = await vectorRecall(provider, "q", index, 1);
		expect(out).toEqual(["theme"]);
	});

	it("空索引返回空", async () => {
		const provider = makeMockProvider({ q: [1, 0, 0] });
		const empty: VectorIndex = { ids: [], vectors: [], hash: "", model: "m1" };
		expect(await vectorRecall(provider, "q", empty, 5)).toEqual([]);
	});

	it("query 向量为空返回空", async () => {
		const provider = makeMockProvider({ q: [] });
		expect(await vectorRecall(provider, "q", index, 5)).toEqual([]);
	});

	it("索引与 query 向量维度不一致时抛错（不再静默错排）", async () => {
		// 2 维 query 去比 3 维索引。旧行为是只比较前 2 维并返回「看似正常」的分数，
		// 于是这类问题会一路静默到 UI 上表现为排序不对；现在应在召回层直接抛出。
		const provider = makeMockProvider({ q: [1, 0] });
		const mismatched: VectorIndex = {
			ids: ["a"],
			vectors: [[1, 0, 0]],
			hash: "h",
			model: "m1",
		};
		await expect(vectorRecall(provider, "q", mismatched, 1)).rejects.toThrow(/维度不一致/);
	});
});

describe("query 向量缓存 · 换模型不得复用旧向量（回归）", () => {
	/**
	 * name 固定为 "api"（刻意与 ApiEmbeddingProvider 同名），使 provider.name 无法区分
	 * 两次召回；返回向量的维度随调用次数变化，用于暴露「缓存键漏模型」的后果。
	 */
	function makeDimChangingProvider(): EmbeddingProvider & { calls: number } {
		const provider = {
			name: "api",
			calls: 0,
			async embed(texts: string[]): Promise<number[][]> {
				this.calls++;
				const dim = 1 + this.calls;
				return texts.map(() => new Array(dim).fill(1 / Math.sqrt(dim)));
			},
		};
		return provider;
	}

	it("同一 provider 下 model 变化 → 缓存不命中，必须重新 embed", async () => {
		const provider = makeDimChangingProvider();
		const idxA: VectorIndex = { ids: ["a"], vectors: [[1, 0]], hash: "h", model: "model-A" };
		const idxB: VectorIndex = { ids: ["a"], vectors: [[1, 0, 0]], hash: "h", model: "model-B" };

		await vectorRecall(provider, "q", idxA, 1);
		expect(provider.calls).toBe(1);

		// 同一 query、同一 provider.name，但索引模型不同：
		// 若缓存键不含模型会命中 model-A 的 2 维向量去比 model-B 的 3 维索引，
		// topKBySimilarity 按较短维度静默截断 → 不报错但排序错误。
		await vectorRecall(provider, "q", idxB, 1);
		expect(provider.calls).toBe(2);
	});

	it("同模型换 endpoint → query 缓存不命中，避免复用另一服务的向量", async () => {
		const provider = makeDimChangingProvider();
		const identityA = getEmbeddingIdentity({ source: "api", baseURL: "https://a.example", model: "model" });
		const identityB = getEmbeddingIdentity({ source: "api", baseURL: "https://b.example", model: "model" });
		const idxA: VectorIndex = {
			ids: ["a"],
			vectors: [[1, 0]],
			hash: "h",
			model: "model",
			embeddingIdentity: identityA,
		};
		const idxB: VectorIndex = {
			ids: ["a"],
			vectors: [[1, 0, 0]],
			hash: "h",
			model: "model",
			embeddingIdentity: identityB,
		};

		await vectorRecall(provider, "q", idxA, 1);
		await vectorRecall(provider, "q", idxA, 1);
		expect(provider.calls).toBe(1);
		await vectorRecall(provider, "q", idxB, 1);
		expect(provider.calls).toBe(2);
	});

	it("model 相同时仍命中缓存（加入模型维度不会让缓存失效）", async () => {
		const provider = makeDimChangingProvider();
		const idx: VectorIndex = { ids: ["a"], vectors: [[1, 0]], hash: "h", model: "model-A" };
		await vectorRecall(provider, "q", idx, 1);
		await vectorRecall(provider, "q", idx, 1);
		expect(provider.calls).toBe(1);
	});

	it("换模型后重建索引：query 向量与索引维度一致，排序仍正确", async () => {
		const provider = makeDimChangingProvider();
		const idxA: VectorIndex = { ids: ["a", "b"], vectors: [[1, 0], [0, 1]], hash: "h", model: "model-A" };
		await vectorRecall(provider, "q", idxA, 2);
		// 换模型 → 新索引维度不同
		const idxB: VectorIndex = {
			ids: ["a", "b"],
			vectors: [[1, 0, 0], [0, 1, 0]],
			hash: "h",
			model: "model-B",
		};
		const out = await vectorRecall(provider, "q", idxB, 2);
		// 用新模型的 3 维向量比较：与 a 同向 → a 第一
		expect(out[0]).toBe("a");
		expect(out.length).toBe(2);
	});
});

describe("provider embed 失败应向上抛（供上层降级）", () => {
	it("embed 抛错时 vectorRecall 抛错", async () => {
		const provider: EmbeddingProvider = {
			name: "fail",
			embed: vi.fn().mockRejectedValue(new Error("network down")),
		};
		const index: VectorIndex = {
			ids: ["a"],
			vectors: [[1, 0]],
			hash: "h",
			model: "m1",
		};
		await expect(vectorRecall(provider, "q", index, 1)).rejects.toThrow(
			"network down"
		);
	});
});

describe("LocalEmbeddingProvider（阶段 2.5）", () => {
	it("空输入直接返回空数组，不触碰 backend", async () => {
		const backend = makeFakeBackend();
		const p = new LocalEmbeddingProvider(backend, "m", "wasm");
		expect(await p.embed([])).toEqual([]);
		expect(backend.calls).toBe(0);
	});

	it("透传 model/wasmPaths 给默认后端（构造校验）", () => {
		const p = new LocalEmbeddingProvider(undefined, "Xenova/foo", "http://w/");
		expect(p.name).toBe("local");
		// 默认后端应为 WorkerLocalBackend（worker 内跑 transformers），且携带传入的 model/wasm
		expect((p as any).backend.name).toContain("worker");
		expect((p as any).backend.cfg.model).toBe("Xenova/foo");
		expect((p as any).backend.cfg.wasmPaths).toBe("http://w/");
	});

	it("不超过 BATCH(32) 时一次调用 backend", async () => {
		const backend = makeFakeBackend();
		const p = new LocalEmbeddingProvider(backend);
		const texts = Array.from({ length: 5 }, (_, i) => `t${i}`);
		const out = await p.embed(texts);
		expect(backend.calls).toBe(1);
		expect(out.length).toBe(5);
		expect(out[0].length).toBe(3);
	});

	it("超过 BATCH(32) 时按 32 切片多次调用", async () => {
		const backend = makeFakeBackend();
		const p = new LocalEmbeddingProvider(backend);
		const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
		const out = await p.embed(texts);
		expect(backend.calls).toBe(3); // 32 + 32 + 6
		expect(out.length).toBe(70);
	});

	it("backend 抛错向上抛出（由上层降级到关键词）", async () => {
		const backend = makeFakeBackend({ throwOnEmbed: true });
		const p = new LocalEmbeddingProvider(backend);
		await expect(p.embed(["a"])).rejects.toThrow("backend boom");
	});
});

describe("本地 embedding 默认模型", () => {
	it("DEFAULT_LOCAL_MODEL 为面向中文的 bge-small-zh", () => {
		expect(DEFAULT_LOCAL_MODEL).toBe("Xenova/bge-small-zh-v1.5");
	});
});

describe("ApiEmbeddingProvider · 瞬时错误重试", () => {
	const config = {
		baseURL: "https://embedding.example.com",
		apiKey: "sk-test",
		model: "m1",
	};

	const okResponse = () => ({
		status: 200,
		json: { data: [{ index: 0, embedding: [1, 0, 0] }] },
		text: "",
		headers: {},
	});

	const errorResponse = (status: number, headers: Record<string, string> = {}) => ({
		status,
		json: { error: { message: `status ${status}` } },
		text: "",
		headers,
	});

	afterEach(() => {
		resetHttpClient();
		vi.useRealTimers();
	});

	it("429 尊重 Retry-After 后重试并成功", async () => {
		vi.useFakeTimers();
		const request = vi.fn()
			.mockResolvedValueOnce(errorResponse(429, { "Retry-After": "2" }))
			.mockResolvedValueOnce(okResponse());
		setHttpClient({ request });

		const pending = new ApiEmbeddingProvider(config).embed(["hello"]);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toEqual([[1, 0, 0]]);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("网络错误可恢复，最多重试 5 次（总请求 6 次）", async () => {
		vi.useFakeTimers();
		const request = vi.fn()
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce(okResponse());
		setHttpClient({ request });

		const pending = new ApiEmbeddingProvider(config).embed(["hello"]);
		await vi.runAllTimersAsync();
		await expect(pending).resolves.toEqual([[1, 0, 0]]);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("连续 5 次重试仍失败后抛错，不再继续请求", async () => {
		vi.useFakeTimers();
		const request = vi.fn().mockResolvedValue(errorResponse(503));
		setHttpClient({ request });

		const pending = new ApiEmbeddingProvider(config).embed(["hello"]);
		const assertion = expect(pending).rejects.toThrow("HTTP 503");
		await vi.runAllTimersAsync();
		await assertion;
		expect(request).toHaveBeenCalledTimes(6);
	});

	it("鉴权/参数类 4xx 不重试", async () => {
		const request = vi.fn().mockResolvedValue(errorResponse(401));
		setHttpClient({ request });

		await expect(new ApiEmbeddingProvider(config).embed(["hello"])).rejects.toThrow("HTTP 401");
		expect(request).toHaveBeenCalledTimes(1);
	});
});

describe("ApiEmbeddingProvider · 响应格式校验", () => {
	const config = {
		baseURL: "https://embedding.example.com",
		apiKey: "sk-test",
		model: "m1",
	};

	const response = (data: unknown) => ({
		status: 200,
		json: { data },
		text: "",
		headers: {},
	});

	afterEach(() => resetHttpClient());

	it("data 数量与输入批次不一致时拒绝响应", async () => {
		const request = vi.fn().mockResolvedValue(response([{ index: 0, embedding: [1, 0] }]));
		setHttpClient({ request });

		await expect(new ApiEmbeddingProvider(config).embed(["a", "b"])).rejects.toThrow("data 数量");
	});

	it("批量响应的 index 重复或越界时拒绝响应", async () => {
		const request = vi.fn().mockResolvedValue(response([
			{ index: 0, embedding: [1, 0] },
			{ index: 0, embedding: [0, 1] },
		]));
		setHttpClient({ request });

		await expect(new ApiEmbeddingProvider(config).embed(["a", "b"])).rejects.toThrow("index 缺失、越界或重复");
	});

	it("向量为空或含非有限数值时拒绝响应", async () => {
		const request = vi.fn().mockResolvedValue(response([{ index: 0, embedding: [1, Number.NaN] }]));
		setHttpClient({ request });

		await expect(new ApiEmbeddingProvider(config).embed(["a"])).rejects.toThrow("有效 embedding 向量");
	});

	it("兼容单条响应省略 index 的实现", async () => {
		const request = vi.fn().mockResolvedValue(response([{ embedding: [1, 0] }]));
		setHttpClient({ request });

		await expect(new ApiEmbeddingProvider(config).embed(["a"])).resolves.toEqual([[1, 0]]);
	});
});

describe("向量索引落盘往返（Translator 层）", () => {
	const sampleIndex: VectorIndex = {
		ids: ["sync", "theme", "kanban"],
		vectors: [
			[0.1, 0.2, 0.3],
			[0.4, 0.5, 0.6],
			[0.7, 0.8, 0.9],
		],
		hash: "abc123",
		model: "Xenova/all-MiniLM-L6-v2",
	};

	it("setVectorIndex 后 getVectorIndex 原样返回（模拟落盘前的内存态）", () => {
		const t = new Translator();
		expect(t.getVectorIndex()).toBeNull();
		t.setVectorIndex(sampleIndex);
		const got = t.getVectorIndex();
		expect(got).not.toBeNull();
		expect(got!.ids).toEqual(["sync", "theme", "kanban"]);
		expect(got!.vectors[1]).toEqual([0.4, 0.5, 0.6]);
		expect(got!.model).toBe("Xenova/all-MiniLM-L6-v2");
	});

	it("JSON 序列化往返不丢精度（模拟写盘→读盘）", () => {
		const t = new Translator();
		t.setVectorIndex(sampleIndex);
		// 模拟 main.ts 的 saveVectorIndex → loadVectorIndex 的 JSON 往返
		const roundTrip: VectorIndex = JSON.parse(
			JSON.stringify(t.getVectorIndex())
		);
		expect(roundTrip.ids).toEqual(sampleIndex.ids);
		expect(roundTrip.vectors).toEqual(sampleIndex.vectors);
		expect(roundTrip.hash).toBe("abc123");
		expect(roundTrip.model).toBe(sampleIndex.model);
	});

	it("落盘往返后可作为 prevIndex 复用（内容未变 → 零 embed）", async () => {
		// 先用 provider 真实构建一次，得到与 plugins 内容一致的 index（hash 匹配）
		const plugins = [
			{ id: "sync", name: "Sync", description: "keep notes in sync across devices" },
			{ id: "theme", name: "Theme", description: "beautiful color themes" },
			{ id: "kanban", name: "Kanban", description: "task board" },
		];
		const providerA = makeFakeBackend();
		const built = await buildVectorIndex(providerA, plugins, "m1");
		// 模拟落盘 → 读盘
		const roundTrip: VectorIndex = JSON.parse(JSON.stringify(built));
		const t = new Translator();
		t.setVectorIndex(roundTrip);

		// 第二次用同一批 plugins + 落盘 index：应直接复用，不再调用 embed
		const providerB = makeFakeBackend();
		const reused = await buildVectorIndex(providerB, plugins, "m1", t.getVectorIndex()!);
		expect(reused).toBe(roundTrip);
		expect(providerB.calls).toBe(0);
	});

	it("setVectorIndex(null) 清空索引", () => {
		const t = new Translator();
		t.setVectorIndex(sampleIndex);
		t.setVectorIndex(null);
		expect(t.getVectorIndex()).toBeNull();
	});
});
