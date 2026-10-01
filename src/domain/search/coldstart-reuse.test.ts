/**
 * 冷启动索引复用契约（回归守卫）。
 *
 * 守护两条独立构建路径的指纹口径一致：
 * - 构建侧：plugin.buildLocalIndex → buildVectorIndex 未传预计算指纹 →
 *   computeFieldsHash(indexPlugins)，分类/标签已内联进条目（identity 取值）；
 * - 搜索侧：AISearcher.localSearch 传 precomputedFieldsHash =
 *   computeIndexFingerprints(allPlugins, (p) => pluginTags[p.id])（经访问器取分类）。
 * 任一侧口径漂移都会让落盘索引在首搜被判定失效 → 每次重启全量重建（曾排查的真实故障面）。
 *
 * 因此索引必须由「构建侧」口径生成，再模拟落盘→读盘，最后走「搜索侧」判定，
 * 才能真实覆盖这个接缝。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import { AISearcher } from "@domain/search/ai";
import { buildVectorIndex, embeddingIndexKey, type VectorIndex } from "@semantic/embedding";
import { computeIndexFingerprints } from "@shared/fingerprint";
import { PluginTagService } from "@domain/catalog/plugin-tags";
import { LLMClient } from "@translation/api/api";

const req = vi.fn();

const PLUGINS = [
	{ id: "dataview", name: "Dataview", description: "Query your notes as a database" },
	{ id: "calendar", name: "Calendar", description: "Track your daily notes" },
	{ id: "git", name: "Git", description: "Version control for your vault" },
	{ id: "translate", name: "Translate", description: "Translate text in notes" },
];

const TAGS = {
	dataview: { category: "data", tags: ["query"] },
	calendar: { category: "productivity", tags: ["time"] },
	git: { category: "dev", tags: ["vcs"] },
	translate: { category: "tool", tags: ["language"] },
};

const EMB = {
	source: "api",
	baseURL: "https://embedding.example.com",
	apiKey: "sk-embedding",
	model: "embedding-model",
} as const;

/** 确定性伪向量：同一文本永远得到同一向量，便于跨路径比对 */
function vecFor(text: string): number[] {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return [((h >>> 0) % 1000) / 1000, ((h >>> 8) >>> 0) % 1, 0.5];
}

describe("冷启动索引复用（重启后首搜不应全量 embed）", () => {
	beforeEach(() => {
		req.mockReset();
		req.mockImplementation(async (opts: { body?: string }) => {
			const body = JSON.parse(String(opts?.body ?? "{}")) as { input?: string[] };
			const inputs = body.input ?? [];
			return {
				status: 200,
				json: { data: inputs.map((t, i) => ({ index: i, embedding: vecFor(t) })) },
			};
		});
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	it("【诊断】构建侧口径 vs 搜索侧口径的 fieldsHash 必须一致", () => {
		// 构建侧：buildLocalIndex 把 category/tags/nameZh/descZh 内联进条目，再 identity 取
		const indexPlugins = PLUGINS.map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description,
			category: (TAGS as any)[p.id]?.category,
			tags: (TAGS as any)[p.id]?.tags,
		}));
		const buildSide = computeIndexFingerprints(indexPlugins as any, (p) => p as any).fields;

		// 搜索侧：localSearch 用 (p) => this.pluginTags[p.id] 取分类
		const searchSide = computeIndexFingerprints(PLUGINS as any, (p) => (TAGS as any)[p.id]).fields;

		expect(buildSide).toBe(searchSide);
	});

	it("【复现】落盘→读盘后首搜应直接复用，embed 只发生在 query 上", async () => {
		const tagService = new PluginTagService();
		tagService.load(TAGS, "v1");
		const llm = new LLMClient({ baseURL: "https://api.example.com", apiKey: "sk-test", model: "test-model" });
		const searcher = new AISearcher(
			{ baseURL: "https://api.example.com", apiKey: "sk-test", model: "test-model", embedding: EMB },
			llm,
			tagService,
		);
		searcher.setPluginTags(TAGS);

		// ── ① 构建侧建索引（模拟上次会话 buildLocalIndex 的产物）──
		const model = embeddingIndexKey({ source: EMB.source, baseURL: EMB.baseURL, model: EMB.model });
		const indexPlugins = PLUGINS.map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description,
			category: (TAGS as any)[p.id]?.category,
			tags: (TAGS as any)[p.id]?.tags,
		}));
		const built = await buildVectorIndex(
			{ name: "mock", embed: async (texts: string[]) => texts.map(vecFor) },
			indexPlugins as any,
			model,
			null,
			"v1",
		);

		// ── ② 模拟 saveVectorIndex → 重启 → loadVectorIndex ──
		const reloaded: VectorIndex = {
			ids: built.ids,
			vectors: built.vectors.map((v) => Float32Array.from(v as ArrayLike<number>)),
			hash: built.hash,
			model: built.model,
			categorySchemaVersion: built.categorySchemaVersion,
			perIdHash: JSON.parse(JSON.stringify(built.perIdHash)),
			fieldsHash: built.fieldsHash, // PR #63 起落盘
		};
		searcher.setVectorIndex(reloaded);

		// ── ③ 重启后首搜 ──
		const before = req.mock.calls.length;
		await searcher.localSearch("database", PLUGINS as any);
		const calls = req.mock.calls.length - before;
		// 取最后一次请求的 input 长度：1 = 只 embed 了 query；>1 = 又 embed 了全库
		const lastBody = JSON.parse(String((req.mock.calls.at(-1) as any)?.[0]?.body ?? "{}")) as { input?: string[] };
		const lastBatch = lastBody.input?.length ?? 0;

		// 诊断：把四个复用判定条件摊开，失败时能直接看出是哪一个不同
		const diag = {
			sameRef: searcher.getVectorIndex() === reloaded,
			modelMatch: reloaded.model === model,
			schemaMatch: reloaded.categorySchemaVersion === tagService.getSchemaVersion(),
			lenMatch: reloaded.ids.length === PLUGINS.length,
			fieldsMatch:
				reloaded.fieldsHash === computeIndexFingerprints(PLUGINS as any, (p) => (TAGS as any)[p.id]).fields,
			calls,
			lastBatch,
		};

		// 期望：复用成功 → 只有一次请求且只含 query（input 长度为 1）
		expect(diag).toMatchObject({
			sameRef: true,
			modelMatch: true,
			schemaMatch: true,
			lenMatch: true,
			fieldsMatch: true,
			calls: 1,
			lastBatch: 1,
		});
	});
});
