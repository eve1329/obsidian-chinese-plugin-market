import { describe, it, expect } from "vitest";
import {
	SearchTiming,
	formatSearchTiming,
	localPhaseMs,
	PHASE,
	EXTERNAL_PHASES,
	type SearchTimingSnapshot,
} from "@domain/search/search-timing";

/**
 * 注入式时钟：按顺序吐出给定值，用尽后固定为最后一个值。
 * 这样每个阶段消耗几次 now() 调用是确定的，可断言精确耗时。
 */
function makeClock(values: number[]): () => number {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)];
}

describe("SearchTiming", () => {
	it("mark 记录「距上一个阶段结束」的区间，阶段按顺序排列", async () => {
		// t0=1000 → mark A=1010(10ms) → mark B=1030(20ms) → finish=1035(总计 35ms)
		const t = SearchTiming.start(makeClock([1000, 1010, 1030, 1035]), () => 42);
		t.mark("A");
		t.mark("B");
		const s = t.finish();

		expect(s.phases).toEqual([
			{ name: "A", ms: 10 },
			{ name: "B", ms: 20 },
		]);
		expect(s.totalMs).toBe(35);
		expect(s.at).toBe(42);
	});

	it("measure 记录被包裹逻辑的耗时（异步）", async () => {
		// t0=0 → measure 起=5 → measure 止=25（20ms）→ finish=30
		const t = SearchTiming.start(makeClock([0, 5, 25, 30]), () => 0);
		const ret = await t.measure("向量召回", async () => "ok");

		expect(ret).toBe("ok");
		expect(t.finish().phases).toEqual([{ name: "向量召回", ms: 20 }]);
	});

	it("measure 在被包裹逻辑抛错时仍然记录耗时，并把错误向上抛", async () => {
		const t = SearchTiming.start(makeClock([0, 5, 25]), () => 0);
		await expect(
			t.measure("向量召回", () => {
				throw new Error("boom");
			})
		).rejects.toThrow("boom");
		// 失败发生在哪一步本身就是关键信息，不能因为抛错就丢掉
		expect(t.finish().phases).toEqual([{ name: "向量召回", ms: 20 }]);
	});

	it("mark 与 measure 可混用，共用同一个区间游标", async () => {
		// t0=0 → measure 起=10 → measure 止=20（10ms）→ mark=30（10ms）
		const t = SearchTiming.start(makeClock([0, 10, 20, 30]), () => 0);
		await t.measure("A", () => undefined);
		t.mark("B");
		expect(t.finish().phases).toEqual([
			{ name: "A", ms: 10 },
			{ name: "B", ms: 10 },
		]);
	});

	it("count 记录计数，同名重复以最后一次为准", () => {
		const t = SearchTiming.start(makeClock([0]), () => 0);
		t.count("向量命中", 100);
		t.count("向量命中", 300);
		t.count("索引重建");
		expect(t.finish().counters).toEqual({ 向量命中: 300, 索引重建: 1 });
	});

	it("finish 返回拷贝：之后继续记录不影响已产出的快照", () => {
		const t = SearchTiming.start(makeClock([0, 10, 20]), () => 0);
		t.mark("A");
		const first = t.finish();

		// 篡改快照不应回写到记录器内部
		first.phases.push({ name: "伪造", ms: 999 });
		first.counters["伪造"] = 1;

		const second = t.finish();
		expect(second.phases).toEqual([{ name: "A", ms: 10 }]);
		expect(second.counters).toEqual({});
	});

	it("空记录器也能产出快照（无阶段、无计数）", () => {
		const t = SearchTiming.start(makeClock([7, 9]), () => 0);
		const s = t.finish();
		expect(s.phases).toEqual([]);
		expect(s.counters).toEqual({});
		expect(s.totalMs).toBe(2);
	});
});

describe("formatSearchTiming", () => {
	it("产出单行结构化摘要（阶段在前，计数在后）", () => {
		const s: SearchTimingSnapshot = {
			phases: [
				{ name: "向量召回", ms: 12.34 },
				{ name: "关键词召回", ms: 0.2 },
			],
			totalMs: 12.54,
			counters: { 向量命中: 300, 关键词命中: 41 },
			at: 0,
		};
		expect(formatSearchTiming(s, "AI 搜索")).toBe(
			"[Chinese Plugin Market] AI 搜索：总计=12.5ms · 向量召回=12.3ms · 关键词召回=0.2ms · 向量命中=300 · 关键词命中=41"
		);
	});

	it("无阶段无计数时只输出总计", () => {
		const s: SearchTimingSnapshot = { phases: [], totalMs: 1.234, counters: {}, at: 0 };
		expect(formatSearchTiming(s, "本地语义")).toBe(
			"[Chinese Plugin Market] 本地语义：总计=1.2ms"
		);
	});
});

describe("localPhaseMs", () => {
	const snap = (phases: { name: string; ms: number }[]): SearchTimingSnapshot => ({
		phases,
		totalMs: phases.reduce((a, p) => a + p.ms, 0),
		counters: {},
		at: 0,
	});

	it("只统计本地计算阶段（关键词召回 / 标题模糊 / RRF 融合）", () => {
		expect(
			localPhaseMs(
				snap([
					{ name: PHASE.keyword, ms: 0.2 },
					{ name: PHASE.fuzzy, ms: 0.3 },
					{ name: PHASE.rrf, ms: 0.1 },
				])
			)
		).toBeCloseTo(0.6, 10);
	});

	it("排除所有外部依赖阶段：LLM 精排 / LLM 兜底召回 / query 编码 / 向量索引", () => {
		// 这些阶段受网络往返或模型推理主导，正常也能到秒级甚至数十秒。
		// 若把它们计入「本地」，任何一次正常搜索都会「看起来慢」，告警随即失去意义。
		expect(
			localPhaseMs(
				snap([
					{ name: PHASE.llmRank, ms: 2000 },
					{ name: PHASE.llmFallback, ms: 1500 },
					{ name: PHASE.queryEncode, ms: 300 },
					{ name: PHASE.vectorIndex, ms: 800 },
					{ name: PHASE.keyword, ms: 0.2 },
				])
			)
		).toBeCloseTo(0.2, 10);
	});

	it("EXTERNAL_PHASES 的每一项都必须是已知阶段名（拼错会静默失效）", () => {
		// 排除集靠「名字相等」判定归属：若这里写错一个字（或改了 PHASE 的值却忘了同步），
		// 对应阶段会被悄悄算进「本地」，指标变错却不报错。
		// 注意：断言「长度=4」是有意的变更探测器 —— 将来给 PHASE 增删阶段时，
		// 这条会提醒你确认新的阶段该不该进排除集。
		const known = new Set<string>(Object.values(PHASE));
		for (const name of EXTERNAL_PHASES) {
			expect(known.has(name)).toBe(true);
		}
		expect(EXTERNAL_PHASES.length).toBe(4);
	});

	it("无阶段时为 0", () => {
		expect(localPhaseMs(snap([]))).toBe(0);
	});
});
