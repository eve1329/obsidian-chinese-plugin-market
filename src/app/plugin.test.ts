import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { Translator } from "@domain/catalog/translator";
import * as embedding from "@semantic/embedding";

/**
 * 持久化层回归（审计 P0-1）。
 * 桩掉 Obsidian 的 saveData/loadData + app，验证 saveSettings（防抖合并）/
 * flushSaveSettings（即时） / onunload（卸载兜底）三路径的写盘契约，
 * 防止「后写覆盖先写」竞态或埋点丢失在重构中被悄悄引入。
 */
function makePlugin() {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	const saveData = vi.fn(async (_data?: Record<string, unknown>) => {});
	// mock 持久化存储层：隔离 credentials/favorites/翻译缓存独立文件的读写，避免触碰真实文件系统
	const storage = {
		loadCredentials: vi.fn(async () => null),
		saveCredentials: vi.fn(async () => {}),
		loadFavorites: vi.fn(async () => null),
		saveFavorites: vi.fn(async () => {}),
		loadTranslatorCache: vi.fn(async () => null),
		loadSeededTranslatorCache: vi.fn(async () => null),
		saveTranslatorCache: vi.fn(async () => {}),
	};
	Object.assign(plugin, {
		saveData,
		loadData: vi.fn(async () => ({})),
		storage,
		_data: {} as Record<string, unknown>,
		settings: {} as never,
		translator: new Translator(),
		app: { workspace: { getLeavesOfType: () => [] } },
		_saveTranslatorDataTimer: null,
	});
	return { plugin, saveData, storage };
}

describe("Plugin 持久化契约（P0 回归）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("连续 saveSettings 合并为单次写盘（防抖 300ms）", async () => {
		const { plugin, saveData } = makePlugin();
		plugin.saveSettings();
		plugin.saveSettings();
		plugin.saveSettings();
		expect(saveData).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(300);
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("flushSaveSettings 立即写盘并取消挂起定时器", async () => {
		const { plugin, saveData } = makePlugin();
		plugin.saveSettings();
		expect(saveData).not.toHaveBeenCalled();
		await plugin.flushSaveSettings();
		expect(saveData).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(300);
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("本地模型旧默认值迁移：all-MiniLM-L6-v2 / bge-small-zh-v1.5 → multilingual-e5-small", async () => {
		const { plugin } = makePlugin();
		// 模拟旧版 data.json 里持久化的旧默认模型名（第一代默认）
		const allData: Record<string, unknown> = {
			embeddingLocalModel: "Xenova/all-MiniLM-L6-v2",
		};
		await (plugin as any).loadSettings(allData);
		expect(plugin.settings.embeddingLocalModel).toBe("Xenova/multilingual-e5-small");
		// 第二代默认（bge-small-zh，中文单语，跨语言召回失效）同样迁移
		const allData3: Record<string, unknown> = {
			embeddingLocalModel: "Xenova/bge-small-zh-v1.5",
		};
		await (plugin as any).loadSettings(allData3);
		expect(plugin.settings.embeddingLocalModel).toBe("Xenova/multilingual-e5-small");
		// 用户主动改的其它模型名应保留
		const allData2: Record<string, unknown> = {
			embeddingLocalModel: "Xenova/custom-model",
		};
		await (plugin as any).loadSettings(allData2);
		expect(plugin.settings.embeddingLocalModel).toBe("Xenova/custom-model");
	});

	it("向量索引未变化时不重复导出 SQLite", async () => {
		const { plugin } = makePlugin();
		const index = {
			ids: ["plugin-a"],
			vectors: [[1, 0]],
			hash: "hash-a",
			model: "local:Xenova/test",
			fieldsHash: "fields-a",
			categorySchemaVersion: "schema-a",
			perIdHash: { "plugin-a": "row-a" },
		};
		plugin.translator.setVectorIndex(index);
		const flush = vi.fn(async () => {});
		const store = {
			getMeta: (key: string) => ({
				model: index.model,
				hash: index.hash,
				fieldsHash: index.fieldsHash,
				categorySchemaVersion: index.categorySchemaVersion,
				perIdHash: JSON.stringify(index.perIdHash),
			}[key] ?? null),
			upsertMany: vi.fn(),
			deleteMany: vi.fn(),
			replaceAll: vi.fn(),
			setMeta: vi.fn(),
			flush,
		};
		Object.assign(plugin as any, { vectorStore: store });

		await plugin.saveVectorIndex();

		expect(store.upsertMany).not.toHaveBeenCalled();
		expect(store.deleteMany).not.toHaveBeenCalled();
		expect(store.replaceAll).not.toHaveBeenCalled();
		expect(store.setMeta).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
	});

	it("模型或分类 schema 变化时重写全部向量行", async () => {
		const { plugin } = makePlugin();
		const index = {
			ids: ["plugin-a"],
			vectors: [[1, 0]],
			hash: "hash-a",
			model: "local:new-model",
			fieldsHash: "fields-a",
			categorySchemaVersion: "schema-new",
			perIdHash: { "plugin-a": "row-a" },
		};
		plugin.translator.setVectorIndex(index);
		const storedMeta: Record<string, string> = {
			model: "local:old-model",
			hash: index.hash,
			fieldsHash: index.fieldsHash,
			categorySchemaVersion: "schema-old",
			perIdHash: JSON.stringify(index.perIdHash),
		};
		const upsertMany = vi.fn();
		const flush = vi.fn(async () => {});
		const store = {
			getMeta: (key: string) => storedMeta[key] ?? null,
			upsertMany,
			deleteMany: vi.fn(),
			replaceAll: vi.fn(),
			setMeta: vi.fn(),
			flush,
		};
		Object.assign(plugin as any, { vectorStore: store });

		await plugin.saveVectorIndex();

		expect(upsertMany).toHaveBeenCalledWith([{ id: "plugin-a", vec: [1, 0], category: undefined }]);
		expect(flush).toHaveBeenCalledTimes(1);
	});

	it("partial checkpoint 不删除旧索引，并持久化可恢复元数据", async () => {
		const { plugin } = makePlugin();
		const index = {
			ids: ["plugin-a"],
			vectors: [[0, 1]],
			hash: "",
			model: "local:test",
			categorySchemaVersion: "schema-a",
			perIdHash: { "plugin-a": "row-a" },
			partial: true,
		};
		plugin.translator.setVectorIndex(index);
		const storedMeta: Record<string, string> = {
			model: index.model,
			hash: "complete-hash",
			fieldsHash: "complete-fields",
			categorySchemaVersion: index.categorySchemaVersion,
			perIdHash: JSON.stringify({ "plugin-a": "old-a", "plugin-b": "old-b" }),
			partial: "0",
		};
		const upsertMany = vi.fn();
		const deleteMany = vi.fn();
		const setMeta = vi.fn();
		const flush = vi.fn(async () => {});
		const store = {
			getMeta: (key: string) => storedMeta[key] ?? null,
			upsertMany,
			deleteMany,
			replaceAll: vi.fn(),
			setMeta,
			flush,
		};
		Object.assign(plugin as any, { vectorStore: store });

		await plugin.saveVectorIndex();

		expect(upsertMany).toHaveBeenCalledWith([{ id: "plugin-a", vec: [0, 1], category: undefined }]);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(setMeta).toHaveBeenCalledWith("partial", "1");
		expect(setMeta).toHaveBeenCalledWith(
			"perIdHash",
			JSON.stringify({ "plugin-a": "row-a", "plugin-b": "old-b" }),
		);
		expect(flush).toHaveBeenCalledTimes(1);
	});

	it("构建期间 refresh 请求标脏，构建结束后仍会安排增量维护", async () => {
		const { plugin } = makePlugin();
		Object.assign(plugin as any, {
			settings: { embeddingSource: "local" },
			buildLocalIndexPromise: Promise.resolve(),
			localIndexState: { status: "building", progress: 1, total: 2 },
		});
		(plugin as any).scheduleIndexRefresh("译文更新");
		expect((plugin as any).indexRefreshDirty).toBe(true);

		// 模拟当前构建 finally 清空 promise 后的下一次调度。
		(plugin as any).buildLocalIndexPromise = null;
		(plugin as any).localIndexState = { status: "done", progress: 2, total: 2 };
		const build = vi.spyOn(plugin, "buildLocalIndex").mockResolvedValue();
		(plugin as any).scheduleIndexRefresh("构建期间发生变更");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(build).toHaveBeenCalledWith(false);
		build.mockRestore();
	});

	it("已有向量被替换且 partialIds 长度不变时仍触发 checkpoint", async () => {
		const { plugin } = makePlugin();
		const total = 512;
		const plugins = Array.from({ length: total }, (_, i) => ({
			id: `p-${i}`,
			name: `P${i}`,
			description: "desc",
		}));
		const model = embedding.embeddingIndexKey({ source: "local", localModel: "test-model" });
		const prev = {
			ids: plugins.map((p) => p.id),
			vectors: plugins.map(() => [1, 0]),
			hash: "old",
			model,
			perIdHash: Object.fromEntries(plugins.map((p) => [p.id, `old-${p.id}`])),
		};
		plugin.translator.setVectorIndex(prev);
		Object.assign(plugin as any, {
			settings: {
				embeddingSource: "local",
				embeddingLocalModel: "test-model",
				embeddingLocalWasmPaths: "",
				embeddingRemoteHost: "",
			},
			vectorIndexLoadPromise: Promise.resolve(),
			localIndexUnloadRequested: false,
		});
		vi.spyOn(plugin as any, "getViewPlugins").mockReturnValue(plugins);
		const save = vi.spyOn(plugin, "saveVectorIndex").mockResolvedValue();
		const build = vi.spyOn(embedding, "buildVectorIndex").mockImplementation(
			async (_provider, indexPlugins, indexModel, _prev, schema, opts) => {
				const updates = new Map(indexPlugins.map((p) => [p.id, [0, 1] as number[]]));
				const hashes = new Map(indexPlugins.map((p) => [p.id, `new-${p.id}`]));
				(opts as embedding.VectorBuildOptions | undefined)?.onPartial?.(updates, hashes);
				return {
					ids: indexPlugins.map((p) => p.id),
					vectors: indexPlugins.map(() => [0, 1]),
					hash: "new",
					model: indexModel,
					categorySchemaVersion: schema,
					perIdHash: Object.fromEntries(hashes),
					buildStats: { embedded: total, reused: 0 },
				};
			},
		);

		await plugin.buildLocalIndex();
		expect(build).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledTimes(2); // checkpoint + 构建完成后的最终保存
		build.mockRestore();
		save.mockRestore();
	});

	it("收藏筛选（favoriteFilter）改为会话级：不再持久化进 settings", async () => {
		const { plugin, saveData } = makePlugin();
		// 旧版 data.json 残留 favoriteFilter（boolean 或枚举）→ 加载后被丢弃，不回落到 settings
		await (plugin as any).loadSettings({ favoriteFilter: true } as Record<string, unknown>);
		expect((plugin.settings as any).favoriteFilter).toBeUndefined();
		await (plugin as any).loadSettings({ favoriteFilter: "unfavorited" } as Record<string, unknown>);
		expect((plugin.settings as any).favoriteFilter).toBeUndefined();
		// saveSettings 不再写回 favoriteFilter
		await (plugin as any).flushSaveSettings();
		const written = (saveData as any).mock.calls.at(-1)[0] as Record<string, unknown>;
		expect(written.favoriteFilter).toBeUndefined();
	});

	it("onunload 对挂起的 settings 兜底落盘", async () => {
		const { plugin, saveData } = makePlugin();
		plugin.saveSettings(); // 挂起，未到 300ms
		plugin.onunload();
		await vi.runAllTimersAsync();
		expect(saveData).toHaveBeenCalled();
	});

	it("个人收藏分离：落盘时写入 favorites.json 且主 data.json 不含 favorites", async () => {
		const { plugin, saveData, storage } = makePlugin();
		// 旧版升级：favorites 内联在主 data.json 中
		const allData: Record<string, unknown> = { favorites: ["foo", "bar"] };
		await (plugin as any).loadSettings(allData);
		expect(plugin.settings.favorites).toEqual(["foo", "bar"]);

		await plugin.flushSaveSettings();
		// 收藏应独立写 favorites.json
		expect(storage.saveFavorites).toHaveBeenCalledWith(["foo", "bar"]);
		// 主 data.json 落盘对象不应再内联 favorites
		expect(saveData).toHaveBeenCalledWith(
			expect.not.objectContaining({ favorites: expect.anything() })
		);
	});

	it("译名彻底解耦：data.json 内联译名经一次性迁移并入独立文件", async () => {
		const { plugin, storage } = makePlugin();
		// 独立文件已有 2 条（不完整快照）
		(storage.loadTranslatorCache as any).mockResolvedValue({
			cache: {
				"only-in-file": { translatedName: "文件独有", translatedDesc: "d", source: "online", provider: "tencent" },
				"both": { translatedName: "文件版", translatedDesc: "d", source: "online", provider: "tencent" },
			},
			aiDict: {},
			pluginInsights: {},
			compareInsights: {},
			coverageSnapshots: [],
			myMemoryBlockedDate: "",
			seenPluginIds: [],
			lastListFetchAt: 0,
		});
		// data.json 仍内联了 3 条（旧版残留）
		const data: Record<string, unknown> = {
			_translatorCache: {
				"only-in-data": { translatedName: "数据独有", translatedDesc: "d", source: "bulk" },
				"both": { translatedName: "数据版", translatedDesc: "d", source: "bulk" },
				"third": { translatedName: "第三条", translatedDesc: "d", source: "online", provider: "tencent" },
			},
			_myMemoryBlockedDate: "2026-01-01",
			_seenPluginIds: ["x"],
			_lastListFetchAt: 123,
		};
		await (plugin as any).migrateTranslatorCacheFromData(data);
		// 迁移应调用 saveTranslatorCache，写出合并后的全集（4 条，both 取独立文件优先）
		expect(storage.saveTranslatorCache).toHaveBeenCalledTimes(1);
		const written = (storage.saveTranslatorCache as any).mock.calls[0][0];
		expect(Object.keys(written.cache).sort()).toEqual(["both", "only-in-data", "only-in-file", "third"].sort());
		expect(written.cache["both"].translatedName).toBe("文件版");
		expect(written.cache["only-in-data"].translatedName).toBe("数据独有");
		expect(written.myMemoryBlockedDate).toBe("2026-01-01");
		expect(written.seenPluginIds).toEqual(["x"]);
	});

	it("译名彻底解耦：loadTranslatorData 只信独立文件，不再与 data.json 合并", async () => {
		const { plugin, storage } = makePlugin();
		// 独立文件为权威源（2 条）
		(storage.loadTranslatorCache as any).mockResolvedValue({
			cache: {
				"f1": { translatedName: "文件1", translatedDesc: "d", source: "online", provider: "tencent" },
				"f2": { translatedName: "文件2", translatedDesc: "d", source: "bulk" },
			},
			aiDict: {},
			pluginInsights: {},
			compareInsights: {},
			coverageSnapshots: [],
			myMemoryBlockedDate: "",
			seenPluginIds: [],
			lastListFetchAt: 0,
		});
		// data.json 仍含过时内联译名（不应再被合并进 translator）
		const allData: Record<string, unknown> = {
			_translatorCache: {
				"stale": { translatedName: "过时", translatedDesc: "d", source: "bulk" },
			},
		};
		await (plugin as any).loadTranslatorData(allData);
		const cache = (plugin as any).translator.cache as Record<string, unknown>;
		expect(Object.keys(cache).sort()).toEqual(["f1", "f2"]); // 仅独立文件，不含 stale
		expect(cache["stale"]).toBeUndefined();
	});

	it("译名彻底解耦：独立文件缺失但 data.json 有内联时，loadTranslatorData 兜底触发迁移", async () => {
		const { plugin, storage } = makePlugin();
		(storage.loadTranslatorCache as any).mockResolvedValue(null); // 独立文件尚未生成
		// 迁移写回后，loadTranslatorCache 应返回刚写入的合并数据（模拟真实适配器落盘）
		(storage.saveTranslatorCache as any).mockImplementation(async (data: any) => {
			(storage.loadTranslatorCache as any).mockResolvedValue(data);
		});
		const allData: Record<string, unknown> = {
			_translatorCache: {
				"a": { translatedName: "甲", translatedDesc: "d", source: "bulk" },
				"b": { translatedName: "乙", translatedDesc: "d", source: "online", provider: "tencent" },
			},
		};
		await (plugin as any).loadTranslatorData(allData);
		// 兜底迁移：把内联写入独立文件
		expect(storage.saveTranslatorCache).toHaveBeenCalledTimes(1);
		const written = (storage.saveTranslatorCache as any).mock.calls[0][0];
		expect(Object.keys(written.cache).sort()).toEqual(["a", "b"]);
		// 且 translator 内存也拿到译名（重读独立文件得到）
		const cache = (plugin as any).translator.cache as Record<string, unknown>;
		expect(Object.keys(cache).sort()).toEqual(["a", "b"]);
	});

	it("种子译名库：本地文件为空时合并种子，用户运行时文件优先覆盖种子", async () => {
		const { plugin, storage } = makePlugin();
		// 用户本地运行时文件为空（新安装/首次升级）
		(storage.loadTranslatorCache as any).mockResolvedValue(null);
		// 随包分发的种子库含 2 条基础译名
		(storage.loadSeededTranslatorCache as any).mockResolvedValue({
			cache: {
				"seed-1": { translatedName: "种子甲", translatedDesc: "d", source: "ai" },
				"seed-2": { translatedName: "种子乙", translatedDesc: "d", source: "ai" },
			},
			aiDict: { "seed-1": { name: "种子甲", description: "d", source: "ai" } },
			pluginInsights: {}, compareInsights: {}, coverageSnapshots: [],
			myMemoryBlockedDate: "", seenPluginIds: [], lastListFetchAt: 0,
		});
		await (plugin as any).loadTranslatorData({});
		const cache = (plugin as any).translator.cache as Record<string, any>;
		// 用户无本地文件 → 直接用种子译名，首屏不再全英文
		expect(Object.keys(cache).sort()).toEqual(["seed-1", "seed-2"]);
		expect(cache["seed-1"].translatedName).toBe("种子甲");

		// 用户本地文件含同名条目时，应以用户文件优先（覆盖种子）
		(storage.loadTranslatorCache as any).mockResolvedValue({
			cache: { "seed-1": { translatedName: "用户校正甲", translatedDesc: "d", source: "bulk" } },
			aiDict: {}, pluginInsights: {}, compareInsights: {},
			coverageSnapshots: [], myMemoryBlockedDate: "", seenPluginIds: [], lastListFetchAt: 0,
		});
		await (plugin as any).loadTranslatorData({});
		const cache2 = (plugin as any).translator.cache as Record<string, any>;
		expect(cache2["seed-1"].translatedName).toBe("用户校正甲"); // 用户覆盖种子
		expect(cache2["seed-2"].translatedName).toBe("种子乙"); // 种子补充用户缺失项
	});
});
