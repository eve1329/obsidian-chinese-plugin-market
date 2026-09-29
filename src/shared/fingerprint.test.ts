import { describe, it, expect } from "vitest";
import {
	computeIndexFingerprints,
	type FingerprintTags,
} from "@shared/fingerprint";

interface Row {
	id: string;
	name: string;
	description: string;
	category?: string;
	tags?: string[];
}

const CORPUS: Row[] = [
	{ id: "p0", name: "Dataview", description: "把笔记当作数据库查询", category: "数据处理", tags: ["查询", "表格"] },
	{ id: "p1", name: "Calendar", description: "日历视图与每日笔记", category: "任务与项目", tags: ["日历"] },
	{ id: "p2", name: "Kanban", description: "看板视图，组织任务卡片", category: "任务与项目", tags: ["看板", "任务"] },
	{ id: "p3", name: "Plain", description: "无分类的插件" }, // 刻意缺 category/tags
	{ id: "p4", name: "Empty", description: "" },
];

const tagsOf = (p: Row): FingerprintTags => ({ category: p.category, tags: p.tags });

/**
 * 参考实现：改造前 embedding.ts 的 computeFieldsHash（逐字复刻）。
 * 用独立实现做对照，才能证明「合并成单趟」没有改变指纹值。
 */
function refFieldsHash(ps: Row[]): string {
	let h = 5381;
	const mix = (s: string) => {
		for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
		h = ((h << 5) + h + 0x1f) | 0;
	};
	for (const p of ps) {
		mix(p.id);
		mix(p.name);
		mix(p.description);
		mix(p.category ?? "");
		for (const t of p.tags ?? []) mix(t);
		h = ((h << 5) + h + 0x1e) | 0;
	}
	return (h >>> 0).toString(16);
}

/**
 * 参考实现：改造前 ai.ts 的 computeBm25Sig（逐字复刻）。
 * 注意与 fields 的分隔符模式不同：bm25 链在 description 之后**直接**接条目分隔符
 * 0x1e（没有额外的 0x1f），因为它到 description 就结束了。
 */
function refBm25Sig(ps: Row[]): string {
	let h = 5381;
	for (const p of ps) {
		for (let i = 0; i < p.id.length; i++) h = (h * 33 + p.id.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		for (let i = 0; i < p.name.length; i++) h = (h * 33 + p.name.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		for (let i = 0; i < p.description.length; i++) {
			h = (h * 33 + p.description.charCodeAt(i)) | 0;
		}
		h = (h * 33 + 0x1e) | 0;
	}
	return (h >>> 0).toString(16);
}

describe("computeIndexFingerprints · 与改造前的两份实现逐位一致", () => {
	it("fields 与旧 computeFieldsHash 一致（含 category/tags）", () => {
		expect(computeIndexFingerprints(CORPUS, tagsOf).fields).toBe(refFieldsHash(CORPUS));
	});

	it("bm25 与旧 computeBm25Sig 一致（只覆盖 id/name/description）", () => {
		expect(computeIndexFingerprints(CORPUS, tagsOf).bm25).toBe(refBm25Sig(CORPUS));
	});

	it("不传 tagsOf 时 fields 等价于「所有插件都没有分类」", () => {
		const stripped = CORPUS.map((p) => ({ id: p.id, name: p.name, description: p.description }));
		expect(computeIndexFingerprints(CORPUS).fields).toBe(refFieldsHash(stripped));
	});

	it("同一输入重复计算结果稳定", () => {
		const a = computeIndexFingerprints(CORPUS, tagsOf);
		const b = computeIndexFingerprints(CORPUS, tagsOf);
		expect(a).toEqual(b);
	});
});

describe("computeIndexFingerprints · 两个签名的失效边界不同（保留双累加器的理由）", () => {
	it("只改 category/tags：fields 变化，bm25 不变", () => {
		const before = computeIndexFingerprints(CORPUS, tagsOf);
		const mutated = CORPUS.map((p) => ({ ...p }));
		mutated[1].category = "换个分类";
		mutated[1].tags = ["改了", "标签"];
		const after = computeIndexFingerprints(mutated, tagsOf);

		// 向量索引依赖分类维度 → 必须察觉
		expect(after.fields).not.toBe(before.fields);
		// BM25 不依赖分类 → 不该被牵连重建（这正是不能用单一累加器的原因）
		expect(after.bm25).toBe(before.bm25);
	});

	it("只改 description：两个签名都变化", () => {
		const before = computeIndexFingerprints(CORPUS, tagsOf);
		const mutated = CORPUS.map((p) => ({ ...p }));
		mutated[2].description += "（已更新）";
		const after = computeIndexFingerprints(mutated, tagsOf);

		expect(after.fields).not.toBe(before.fields);
		expect(after.bm25).not.toBe(before.bm25);
	});

	it("只改 name：两个签名都变化", () => {
		const before = computeIndexFingerprints(CORPUS, tagsOf);
		const mutated = CORPUS.map((p) => ({ ...p }));
		mutated[0].name = "Dataview Renamed";
		const after = computeIndexFingerprints(mutated, tagsOf);

		expect(after.fields).not.toBe(before.fields);
		expect(after.bm25).not.toBe(before.bm25);
	});

	it("中间条目内容变化可被察觉（旧「长度 + 首尾 id」签名漏判的场景）", () => {
		const before = computeIndexFingerprints(CORPUS, tagsOf);
		const mutated = CORPUS.map((p) => ({ ...p }));
		mutated[2].description += "x";
		const after = computeIndexFingerprints(mutated, tagsOf);

		// 条目数、首尾 id 均未变
		expect(mutated.length).toBe(CORPUS.length);
		expect(mutated[0].id).toBe(CORPUS[0].id);
		expect(mutated[mutated.length - 1].id).toBe(CORPUS[CORPUS.length - 1].id);
		expect(after.bm25).not.toBe(before.bm25);
	});

	it("条目顺序变化会改变签名（顺序影响召回结果）", () => {
		const before = computeIndexFingerprints(CORPUS, tagsOf);
		const reordered = [CORPUS[1], CORPUS[0], ...CORPUS.slice(2)];
		expect(computeIndexFingerprints(reordered, tagsOf).bm25).not.toBe(before.bm25);
	});
});

describe("computeIndexFingerprints · 边界", () => {
	it("空列表返回稳定的初始值", () => {
		const a = computeIndexFingerprints([]);
		const b = computeIndexFingerprints([], tagsOf);
		expect(a).toEqual(b);
		expect(a.bm25).toBe(a.fields);
	});

	it("拼接歧义不会撞车：['ab','c'] 与 ['a','bc'] 不同", () => {
		const x = computeIndexFingerprints([{ id: "ab", name: "", description: "c" }]);
		const y = computeIndexFingerprints([{ id: "a", name: "bc", description: "" }]);
		expect(x.bm25).not.toBe(y.bm25);
	});
});
