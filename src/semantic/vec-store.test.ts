import { describe, it, expect, beforeAll } from "vitest";
import { SqliteVectorStore, type PersistAdapter } from "@semantic/vec-store";
import { quantizeVec, dequantizeVec } from "@semantic/vec-codec";

// sql.js 在 Node 测试环境用其 wasm。用 Node fs 读 wasm 初始化。
import * as fs from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const file = "__test_vec_store.sqlite";

beforeAll(async () => {
	const require = createRequire(import.meta.url);
	const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
	const buf = fs.readFileSync(wasmPath);
	const ab = new ArrayBuffer(buf.byteLength);
	new Uint8Array(ab).set(buf);
	SQL = await initSqlJs({ wasmBinary: ab });
});

describe("quantizeVec / dequantizeVec", () => {
	it("往返还原接近原始，相对序保持", () => {
		const v = [1.0, 0.0, -1.0, 0.5];
		const back = Array.from(dequantizeVec(quantizeVec(v)));
		expect(back.length).toBe(4);
		expect(Math.abs(back[0] - 1.0)).toBeLessThan(0.1);
		expect(back[0]).toBeGreaterThan(back[1]);
		expect(back[0]).toBeGreaterThan(back[2]);
	});
});

describe("SqliteVectorStore", () => {
	const mkAdapter = (): { adapter: PersistAdapter; bytes: Uint8Array | null } => {
		let data: Uint8Array | null = null;
		const adapter: PersistAdapter = {
			exists: async () => data !== null,
			read: async () => data!,
			write: async (_p, b) => {
				data = b;
			},
		};
		return { adapter, bytes: () => data } as any;
	};

	it("replaceAll → getAllVecs 往返", async () => {
		const { adapter } = mkAdapter();
		const store = await SqliteVectorStore.open(adapter, file, SQL as any);
		store.replaceAll([
			{ id: "a", vec: [1, 0, 0] },
			{ id: "b", vec: [0, 1, 0] },
			{ id: "c", vec: [0, 0, 1], category: "cat1", tags: ["t1"] },
		]);
		const vecs = store.getAllVecs();
		expect(vecs.size).toBe(3);
		expect(vecs.has("a")).toBe(true);
		expect(store.count()).toBe(3);
		const rows = store.getAllRows();
		expect(rows.find((r) => r.id === "c")?.category).toBe("cat1");
		await store.dispose();
	});

	it("持久化：flush 后可从 bytes 重新打开", async () => {
		const { adapter } = mkAdapter();
		let s = await SqliteVectorStore.open(adapter, file, SQL as any);
		s.replaceAll([{ id: "x", vec: [0.2, 0.8] }]);
		s.setMeta("model", "m1");
		await s.flush();
		await s.dispose();

		// 重新打开（adapter.read 返回之前写入的 bytes）
		const s2 = await SqliteVectorStore.open(adapter, file, SQL as any);
		expect(s2.count()).toBe(1);
		expect(s2.getMeta("model")).toBe("m1");
		const vecs = s2.getAllVecs();
		expect(vecs.size).toBe(1);
		await s2.dispose();
	});

	it("meta 往返", async () => {
		const { adapter } = mkAdapter();
		const store = await SqliteVectorStore.open(adapter, file, SQL as any);
		expect(store.getMeta("nope")).toBeNull();
		store.setMeta("hash", "abc");
		expect(store.getMeta("hash")).toBe("abc");
		await store.dispose();
	});

	it("upsertMany 只改目标行，不触及其他行", async () => {
		const { adapter } = mkAdapter();
		const store = await SqliteVectorStore.open(adapter, file, SQL as any);
		store.replaceAll([
			{ id: "a", vec: [1, 0, 0] },
			{ id: "b", vec: [0, 1, 0] },
		]);
		// 只 upsert b（向量变化）和新增 c，a 应原样保留
		store.upsertMany([
			{ id: "b", vec: [0, 2, 0] },
			{ id: "c", vec: [0, 0, 3] },
		]);
		expect(store.count()).toBe(3);
		expect(store.getAllVecs().get("a")![1]).toBeCloseTo(0); // a 未被改
		expect(store.getAllVecs().get("b")![1]).toBeCloseTo(2); // b 已更新
		expect(store.getAllVecs().get("c")![2]).toBeCloseTo(3); // c 已插入
		await store.dispose();
	});

	it("deleteMany 只删目标行，不触及其他行", async () => {
		const { adapter } = mkAdapter();
		const store = await SqliteVectorStore.open(adapter, file, SQL as any);
		store.replaceAll([
			{ id: "a", vec: [1, 0, 0] },
			{ id: "b", vec: [0, 1, 0] },
			{ id: "c", vec: [0, 0, 1] },
		]);
		store.deleteMany(["b"]);
		expect(store.count()).toBe(2);
		expect(store.getAllVecs().has("a")).toBe(true);
		expect(store.getAllVecs().has("b")).toBe(false);
		expect(store.getAllVecs().has("c")).toBe(true);
		await store.dispose();
	});

	it("upsertMany + deleteMany 落盘后可从 bytes 重新打开", async () => {
		const { adapter } = mkAdapter();
		const s = await SqliteVectorStore.open(adapter, file, SQL as any);
		s.replaceAll([{ id: "a", vec: [1, 0] }, { id: "b", vec: [0, 1] }, { id: "c", vec: [1, 1] }]);
		s.upsertMany([{ id: "a", vec: [9, 0] }]);
		s.deleteMany(["b"]);
		await s.flush();
		await s.dispose();

		const s2 = await SqliteVectorStore.open(adapter, file, SQL as any);
		expect(s2.count()).toBe(2);
		expect(s2.getAllVecs().get("a")![0]).toBeCloseTo(9); // 改动已持久化
		expect(s2.getAllVecs().has("b")).toBe(false); // 删除已持久化
		await s2.dispose();
	});

	it("dispose 会冲刷未达阈值的变更（不能依赖外部先调 flush）", async () => {
		const { adapter } = mkAdapter();
		const s = await SqliteVectorStore.open(adapter, file, SQL as any);
		s.replaceAll([{ id: "pending", vec: [0.3, 0.7] }]); // 仅 1 次变更，远小于 100 阈值
		s.setMeta("model", "dispose-flush");
		// 关键：不显式 flush，直接 dispose —— 旧实现先置 disposed 再 flush 会被自身短路
		await s.dispose();

		const s2 = await SqliteVectorStore.open(adapter, file, SQL as any);
		expect(s2.count()).toBe(1);
		expect(s2.getMeta("model")).toBe("dispose-flush");
		await s2.dispose();
	});

	it("写盘 await 窗口内到达的变更不会被 mutationCount 清零吞掉", async () => {
		const { adapter: base } = mkAdapter();
		// 可控的写盘：第一次 write 挂起，等我们在 await 窗口里制造新变更后再放行
		let release: (() => void) | null = null;
		const gate = new Promise<void>((r) => { release = r; });
		let calls = 0;
		const adapter: PersistAdapter = {
			exists: base.exists,
			read: base.read,
			write: async (p, b) => {
				calls++;
				if (calls === 1) await gate;
				await base.write(p, b);
			},
		};

		const s = await SqliteVectorStore.open(adapter, file, SQL as any);
		s.replaceAll([{ id: "w1", vec: [1, 0] }]);
		const first = s.flush(); // 进入 export→await write 窗口
		// 窗口内的新变更：旧实现在写盘结束后把 mutationCount 归零，使其再无写盘触发器。
		// 这批变更达到阈值，验证第一次 flush 完成后会自动补起第二次写盘，
		// 而不是等 dispose() 才碰巧补写。
		for (let i = 0; i < 100; i++) {
			s.upsertMany([{ id: `late-${i}`, vec: [0, 1] }]);
		}
		release!();
		await first;
		expect(calls).toBeGreaterThanOrEqual(2);
		await s.dispose();

		const s2 = await SqliteVectorStore.open(adapter, file, SQL as any);
		expect(s2.count()).toBe(101);
		await s2.dispose();
	});
});
