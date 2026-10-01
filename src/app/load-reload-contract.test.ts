/**
 * 实证：loadVectorIndex → saveVectorIndex → reload → buildVectorIndex 复用契约。
 * 这是「重启后能否复用索引、不重建」的决定性一击。
 * 若通过，说明代码逻辑正确，重启重建是运行时/环境问题；若失败，直接暴露 bug。
 */
import { describe, it, expect } from "vitest";
import ChinesePluginMarketPlugin from "./plugin";
import { Translator } from "../domain/catalog/translator";
import { SqliteVectorStore } from "../semantic/vec-store";
import { buildVectorIndex, embeddingIndexKey, DEFAULT_LOCAL_MODEL } from "../semantic/embedding";
import type { EmbeddingProvider } from "../semantic/embedding";

import * as fs from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

function makeFakeProvider(): EmbeddingProvider {
	const dim = 8;
	let calls = 0;
	const provider = {
		name: "fake",
		async embed(texts: string[]): Promise<number[][]> {
			calls += texts.length;
			(provider as any).calls = calls;
			return texts.map((t) => {
				const v = new Array(dim).fill(0);
				for (let i = 0; i < dim; i++) v[i] = (t.charCodeAt(i % Math.max(1, t.length)) || 1) / 100;
				return v;
			});
		},
	} as unknown as EmbeddingProvider;
	return provider;
}

function idxPlugins() {
	return [
		{ id: "dataview", name: "Dataview", description: "Query notes", category: "data", tags: ["q"], nameZh: "数据库视图", descZh: "把笔记当库" },
		{ id: "calendar", name: "Calendar", description: "Track notes", category: "prod", tags: ["t"], nameZh: "日历", descZh: "每日笔记" },
		{ id: "git", name: "Git", description: "Version control", category: "dev", tags: ["vcs"], nameZh: "版本控制", descZh: "仓库版本控制" },
	];
}

function mkPlugin(): any {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never) as any;
	const translator = new Translator();
	plugin.translator = translator;
	plugin.settings = { embeddingSource: "local", embeddingLocalModel: DEFAULT_LOCAL_MODEL } as any;
	translator.setPluginTags({
		dataview: { category: "data", tags: ["q"] },
		calendar: { category: "prod", tags: ["t"] },
		git: { category: "dev", tags: ["vcs"] },
	} as any, "svc-v1");
	plugin.pluginTagMap = new Map<string, string>([
		["dataview", "data"], ["calendar", "prod"], ["git", "dev"],
	]);
	return plugin;
}

describe("向量索引 load→save→reload→reuse 契约", () => {
	it("重启后应从 store 恢复索引并增量复用（0 次 embed）", async () => {
		const require = createRequire(import.meta.url);
		const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
		const buf = fs.readFileSync(wasmPath);
		const ab = new ArrayBuffer(buf.byteLength);
		new Uint8Array(ab).set(buf);
		SQL = await initSqlJs({ wasmBinary: ab });

		const bytes: Record<string, Uint8Array> = {};
		const adapter = {
			exists: async (p: string) => p in bytes,
			read: async (p: string) => bytes[p],
			write: async (p: string, data: Uint8Array) => { bytes[p] = data; },
		};
		const store = await SqliteVectorStore.open(adapter as any, "vector-index.sqlite", SQL as any);

		const plugin = mkPlugin();
		plugin.vectorStore = store;

		const provider = makeFakeProvider();
		const model = embeddingIndexKey({ source: "local", localModel: DEFAULT_LOCAL_MODEL });
		const plugins = idxPlugins();

		// 1) 首装构建（prevIdx=null）→ 落盘
		const built = await buildVectorIndex(provider, plugins as any, model, null, "svc-v1");
		expect(built.ids.length).toBe(3);
		expect(built.perIdHash && Object.keys(built.perIdHash).length).toBe(3);
		expect((provider as any).calls).toBe(3);
		plugin.translator.setVectorIndex(built);
		await plugin.saveVectorIndex();

		// 2) 模拟重启：清空内存索引
		plugin.translator.setVectorIndex(null);
		expect(plugin.translator.getVectorIndex()).toBeNull();

		// 3) 重启后从 store 恢复
		await plugin.loadVectorIndex();
		const restored = plugin.translator.getVectorIndex();
		expect(restored).not.toBeNull();
		expect(restored!.perIdHash && Object.keys(restored!.perIdHash).length).toBe(3);
		expect(restored!.fieldsHash).toBe(built.fieldsHash);
		expect(restored!.model).toBe(built.model);

		// 4) 重启后再次构建：应增量复用（0 次新 embed）
		const beforeCalls = (provider as any).calls;
		const reused = await buildVectorIndex(provider, plugins as any, model, restored, "svc-v1");
		expect((provider as any).calls).toBe(beforeCalls);
		expect(reused).toBe(restored);

		await store.dispose();
	});

	it("模型 key 不对称（用户清空 embeddingLocalModel）不应导致每次重启全量重建", async () => {
		// 复现真实故障面：构建侧兜底 DEFAULT_LOCAL_MODEL → key=`local|Xenova/...`，
		// 搜索侧透传空 localModel → 修复前 embeddingIndexKey 返回裸 "local" → 两侧 key 不同 →
		// buildLocalIndex 写 A key、首搜期待 B key → 每次重启全量重建。
		// 修复后 embeddingIndexKey 对空 localModel 归一到 DEFAULT_LOCAL_MODEL，两侧 key 必一致。
		expect(embeddingIndexKey({ source: "local", localModel: "" }))
			.toBe(embeddingIndexKey({ source: "local", localModel: DEFAULT_LOCAL_MODEL }));

		const require = createRequire(import.meta.url);
		const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
		const buf = fs.readFileSync(wasmPath);
		const ab = new ArrayBuffer(buf.byteLength);
		new Uint8Array(ab).set(buf);
		const SQL2 = await initSqlJs({ wasmBinary: ab });

		const bytes: Record<string, Uint8Array> = {};
		const adapter = {
			exists: async (p: string) => p in bytes,
			read: async (p: string) => bytes[p],
			write: async (p: string, data: Uint8Array) => { bytes[p] = data; },
		};
		const store = await SqliteVectorStore.open(adapter as any, "v2.sqlite", SQL2 as any);

		const plugin = mkPlugin();
		plugin.vectorStore = store;
		const provider = makeFakeProvider();
		// 构建侧 key（兜底后）
		const buildModel = embeddingIndexKey({ source: "local", localModel: DEFAULT_LOCAL_MODEL });
		const plugins = idxPlugins();

		const built = await buildVectorIndex(provider, plugins as any, buildModel, null, "svc-v1");
		plugin.translator.setVectorIndex(built);
		await plugin.saveVectorIndex();

		plugin.translator.setVectorIndex(null);
		await plugin.loadVectorIndex();
		const restored = plugin.translator.getVectorIndex();
		expect(restored).not.toBeNull();

		// 搜索侧用空 localModel（用户清空设置的真实输入）重建 key
		const searchModel = embeddingIndexKey({ source: "local", localModel: "" });
		const beforeCalls = (provider as any).calls;
		const reused = await buildVectorIndex(provider, plugins as any, searchModel, restored, "svc-v1");
		expect((provider as any).calls).toBe(beforeCalls); // 0 次新 embed → 复用成立
		expect(reused).toBe(restored);

		await store.dispose();
	});
});
