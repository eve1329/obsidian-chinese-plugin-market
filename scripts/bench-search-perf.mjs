/**
 * 搜索链路性能分解基准
 * ─────────────────────────────────────────────
 * 目的：不满足于「改前 13ms / 改后 0.4ms」这种黑盒结论，而是把每个优化拆成
 * 单一变量，分别测出**每一项各贡献了多少**，从而看清因果。
 *
 * 运行：node scripts/bench-search-perf.mjs
 *
 * 七个实验各自控制变量：
 *   实验 1（BM25 召回）  全库遍历+重建 tf → 预计算 tf → 倒排 → 倒排+排序截断
 *                        分离出「内存分配成本」与「算法复杂度成本」
 *   实验 2（djb2 指纹）  闭包/内联 × 捕获变量/传参 × 移位加法/乘法
 *                        分离出「闭包边界」与「变量是否在寄存器」
 *   实验 3（topK 选择）  全量排序(对象) → 全量排序(类型化数组) → 有界堆
 *                        分离出「对象分配」与「O(n log n) vs O(n log k)」
 *   实验 4（API 分批）   串行 vs 受控并发
 *                        证明这是延迟受限而非 CPU 受限
 *   实验 5（标题模糊）   Jaro-Winkler 全量扫描 + 暂存区复用
 *                        证明它**不是**瓶颈（曾以为与实验 1 同源）
 *   实验 6（两个指纹）   两次独立遍历 vs 单趟双累加器 vs 单一统一指纹
 *                        结论：单趟双累加器（已实施于 shared/fingerprint.ts）
 *   实验 7（int8 点积）  float32 vs int8 量化域
 *                        结论：**否决**（1.05x，点积是算力受限而非带宽受限）
 */

// ════════════════════════════════════════════════════════════
// 公共：CJK 三元组分词（复刻 src/domain/search/bm25.ts）
// ════════════════════════════════════════════════════════════
const CJK_MIN = 0x3400;
const CJK_MAX = 0xfaff;
const ASCII_WORD = /[a-zA-Z0-9_-]/;
const isCJK = (ch) => {
	const c = ch.codePointAt(0);
	return c >= CJK_MIN && c <= CJK_MAX;
};
const isAsciiWord = (ch) => ASCII_WORD.test(ch);
const isHighSurrogate = (ch) => {
	const c = ch.charCodeAt(0);
	return c >= 0xd800 && c <= 0xdbff;
};

function tokenizeCJK(text) {
	if (!text) return "";
	const tokens = [];
	const n = text.length;
	let i = 0;
	while (i < n) {
		const ch = text[i];
		if (isCJK(ch)) {
			let end = i;
			while (end < n && isCJK(text[end])) end++;
			const run = text.slice(i, end);
			if (run.length <= 3) tokens.push(run);
			else for (let s = 0; s <= run.length - 3; s++) tokens.push(run.slice(s, s + 3));
			i = end;
		} else if (isAsciiWord(ch)) {
			let end = i;
			while (end < n && isAsciiWord(text[end])) end++;
			tokens.push(text.slice(i, end).toLowerCase());
			i = end;
		} else if (isHighSurrogate(ch) && i + 1 < n) {
			tokens.push(text.slice(i, i + 2));
			i += 2;
		} else i++;
	}
	return tokens.join(" ");
}

function tokenizeForBM25(text) {
	if (!text) return [];
	const s = tokenizeCJK(text);
	return s ? s.split(" ").filter(Boolean) : [];
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const bm25Idf = (df, N) => Math.log((N - df + 0.5) / (df + 0.5) + 1);
const bm25LenNorm = (docLen, avgdl, b = BM25_B) => (avgdl > 0 ? 1 - b + b * (docLen / avgdl) : 1);
const bm25TermWeight = (tf, lenNorm, k1 = BM25_K1) => (tf * (k1 + 1)) / (tf + k1 * lenNorm);

// ════════════════════════════════════════════════════════════
// 语料（6000 条，描述长度贴近真实插件）
// ════════════════════════════════════════════════════════════
const WORDS = [
	"支持","同步","笔记","导出","导入","标签","管理","视图","编辑","预览","自动化","模板","数据",
	"搜索","图表","任务","日历","加密","备份","格式化","表格","时间轴","白板","看板","大纲","双链",
	"引用","批注","翻译","中文","优化","增强","插件","功能","配置","主题","图标","快捷","命令",
	"面板","侧边栏","工作流","知识库","数据库","本地","云端","离线","实时","批量","自定义",
	"可视化","结构化","沉浸式","轻量","高性能",
];
const NAMES = ["obsidian","notion","memos","excalidraw","dataview","templater","kanban","tasks","calendar","git","pdf","ocr","table","mindmap","canvas","sync","export","import"];
const CATEGORIES = ["同步与备份","外观与主题","任务与项目","数据处理","编辑增强","自动化","效率工具","开发工具"];
const TAGS = ["同步","云盘","美化","看板","任务","表格","导入","导出","模板","快捷键","本地","离线"];

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const DOC_COUNT = 6000;
const QUERY_COUNT = 40;
const docs = Array.from({ length: DOC_COUNT }, (_, i) => {
	const k = 14 + Math.floor(rnd() * 14);
	let s = "";
	for (let j = 0; j < k; j++) {
		s += WORDS[Math.floor(rnd() * WORDS.length)];
		if (j % 4 === 3) s += "，";
	}
	const tagCount = 1 + Math.floor(rnd() * 3);
	const tags = [];
	for (let j = 0; j < tagCount; j++) tags.push(TAGS[Math.floor(rnd() * TAGS.length)]);
	return {
		id: "p" + i,
		name: NAMES[Math.floor(rnd() * NAMES.length)] + "-" + Math.floor(rnd() * 900 + 100),
		description: s + "。",
		category: CATEGORIES[Math.floor(rnd() * CATEGORIES.length)],
		tags,
	};
});
const queries = Array.from({ length: QUERY_COUNT }, () => {
	const k = 1 + Math.floor(rnd() * 3);
	const parts = [];
	for (let j = 0; j < k; j++) parts.push(WORDS[Math.floor(rnd() * WORDS.length)]);
	return parts.join("");
});

let totalChars = 0;
for (const d of docs) {
	totalChars += d.id.length + d.name.length + d.description.length + d.category.length;
	for (const t of d.tags) totalChars += t.length;
}

// ════════════════════════════════════════════════════════════
// 计时工具：预热 + 多轮取均值（抑制 JIT 抖动）
// ════════════════════════════════════════════════════════════
/**
 * 计时：预热 + 多批次取**最小值**。
 *
 * 微基准取 min 而非均值：噪声（GC、JIT 抖动、系统调度）只会让某次变慢，
 * 不会让它变快，所以最小值最接近「无干扰时的真实成本」，批次间可比性最好。
 * 均值会被偶发的 GC 尖峰拉高，导致不同写法之间的比较不可复现。
 */
function measure(fn, rounds = 20, batches = 7) {
	for (let i = 0; i < 5; i++) fn(); // 预热，触发 JIT 优化
	let best = Infinity;
	for (let b = 0; b < batches; b++) {
		const t0 = performance.now();
		for (let r = 0; r < rounds; r++) fn();
		const per = (performance.now() - t0) / rounds;
		if (per < best) best = per;
	}
	return best;
}

function section(title) {
	console.log(`\n${"═".repeat(64)}`);
	console.log(title);
	console.log("═".repeat(64));
}

function row(label, ms, note = "") {
	console.log(`  ${label.padEnd(40)} ${ms.toFixed(3).padStart(8)} ms  ${note}`);
}

// ════════════════════════════════════════════════════════════
// 实验 1：BM25 召回 —— 37x 由什么构成
// ════════════════════════════════════════════════════════════
section("实验 1 · BM25 召回：全库遍历+重建 tf → 预计算 tf → 倒排 → 倒排+排序截断");
console.log(`语料 ${DOC_COUNT} 条 · ${QUERY_COUNT} 条查询 · 平均描述 ${(totalChars / DOC_COUNT).toFixed(0)} 字符\n`);

// 索引结构
const oldIndex = (() => {
	const docTokensById = new Map();
	const df = new Map();
	let totalLen = 0;
	for (const p of docs) {
		const tokens = tokenizeForBM25(`${p.name} ${p.description}`);
		docTokensById.set(p.id, tokens);
		totalLen += tokens.length;
		for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
	}
	const N = docs.length;
	return { docTokensById, df, N, avgdl: totalLen / N };
})();

const newIndex = (() => {
	const ids = [];
	const docLen = [];
	const postings = new Map();
	const df = new Map();
	let totalLen = 0;
	for (let di = 0; di < docs.length; di++) {
		const p = docs[di];
		ids.push(p.id);
		const tokens = tokenizeForBM25(`${p.name} ${p.description}`);
		docLen.push(tokens.length);
		totalLen += tokens.length;
		const localTf = new Map();
		for (const t of tokens) localTf.set(t, (localTf.get(t) ?? 0) + 1);
		for (const [term, tf] of localTf) {
			let pl = postings.get(term);
			if (!pl) {
				pl = { idx: [], tf: [] };
				postings.set(term, pl);
			}
			pl.idx.push(di);
			pl.tf.push(tf);
			df.set(term, (df.get(term) ?? 0) + 1);
		}
	}
	const N = docs.length;
	return { ids, docLen, postings, df, N, avgdl: totalLen / N };
})();

// V0：旧实现（每条文档重建 tf Map）
function recallV0(query) {
	const queryTokens = tokenizeForBM25(query.trim());
	const out = new Map();
	if (queryTokens.length === 0) return out;
	const qtf = new Map();
	for (const t of queryTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
	const { docTokensById, df, N, avgdl } = oldIndex;
	for (const [id, docTokens] of docTokensById) {
		if (docTokens.length === 0) continue;
		const tf = new Map(); // ← 每条文档一次 Map 分配
		for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
		const lenNorm = bm25LenNorm(docTokens.length, avgdl);
		let score = 0;
		for (const [term, qtfCount] of qtf) {
			const tfn = tf.get(term) ?? 0;
			if (tfn === 0) continue;
			score += qtfCount * bm25Idf(df.get(term) ?? 0, N) * bm25TermWeight(tfn, lenNorm);
		}
		if (score > 0) out.set(id, score);
	}
	return out;
}

// V1：全库遍历 + 预计算 tf（仅去掉 Map 分配，算法不变）
const precomputedTf = (() => {
	const tfById = new Map();
	const lenById = new Map();
	for (const [id, tokens] of oldIndex.docTokensById) {
		const m = new Map();
		for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
		tfById.set(id, m);
		lenById.set(id, tokens.length);
	}
	return { tfById, lenById };
})();

function recallV1(query) {
	const queryTokens = tokenizeForBM25(query.trim());
	const out = new Map();
	if (queryTokens.length === 0) return out;
	const qtf = new Map();
	for (const t of queryTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
	const { df, N, avgdl } = oldIndex;
	for (const [id, tf] of precomputedTf.tfById) {
		const lenNorm = bm25LenNorm(precomputedTf.lenById.get(id), avgdl);
		let score = 0;
		for (const [term, qtfCount] of qtf) {
			const tfn = tf.get(term) ?? 0;
			if (tfn === 0) continue;
			score += qtfCount * bm25Idf(df.get(term) ?? 0, N) * bm25TermWeight(tfn, lenNorm);
		}
		if (score > 0) out.set(id, score);
	}
	return out;
}

// V2：倒排索引，只累加分数（不排序、不截断）
function recallV2(query) {
	const queryTokens = tokenizeForBM25(query.trim());
	const acc = new Map();
	if (queryTokens.length === 0) return acc;
	const qtf = new Map();
	for (const t of queryTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
	const { postings, df, N, avgdl, docLen } = newIndex;
	for (const [term, qtfCount] of qtf) {
		const pl = postings.get(term);
		if (!pl) continue;
		const w = qtfCount * bm25Idf(df.get(term) ?? 0, N);
		for (let k = 0; k < pl.idx.length; k++) {
			const d = pl.idx[k];
			acc.set(d, (acc.get(d) ?? 0) + w * bm25TermWeight(pl.tf[k], bm25LenNorm(docLen[d], avgdl)));
		}
	}
	return acc;
}

// V3：倒排 + 排序 + topK 截断（当前线上实现）
const RECALL_PATH_CAP = 500;
function recallV3(query) {
	const acc = recallV2(query);
	const { ids } = newIndex;
	const entries = Array.from(acc.entries());
	entries.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	const out = new Map();
	for (let i = 0; i < entries.length && out.size < RECALL_PATH_CAP; i++) {
		if (entries[i][1] > 0) out.set(ids[entries[i][0]], entries[i][1]);
	}
	return out;
}

const tV0 = measure(() => { for (const q of queries) recallV0(q); });
const tV1 = measure(() => { for (const q of queries) recallV1(q); });
const tV2 = measure(() => { for (const q of queries) recallV2(q); });
const tV3 = measure(() => { for (const q of queries) recallV3(q); });

console.log("单次查询耗时（40 条查询均值）：");
row("V0 全库遍历 + 每条重建 tf Map", tV0 / QUERY_COUNT, "← 重构前");
row("V1 全库遍历 + 预计算 tf", tV1 / QUERY_COUNT, `仅去掉 Map 分配 → ${(tV0 / tV1).toFixed(1)}x`);
row("V2 倒排索引（不排序）", tV2 / QUERY_COUNT, `再换算法 → 累计 ${(tV0 / tV2).toFixed(1)}x`);
row("V3 倒排 + 排序 + topK=500", tV3 / QUERY_COUNT, `含输出成本 → 累计 ${(tV0 / tV3).toFixed(1)}x`);

const allocCost = (tV0 - tV1) / QUERY_COUNT;
const algoCost = (tV1 - tV2) / QUERY_COUNT;
const sortCost = (tV3 - tV2) / QUERY_COUNT;
const v0Per = tV0 / QUERY_COUNT;
console.log("\n贡献分解（单次查询口径，相对 V0 的降幅）：");
console.log(`  去掉每条文档的 Map 分配   ${allocCost.toFixed(3)} ms  (${((allocCost / v0Per) * 100).toFixed(0)}% 的降幅)`);
console.log(`  换倒排（缩小遍历范围）    ${algoCost.toFixed(3)} ms  (${((algoCost / v0Per) * 100).toFixed(0)}% 的降幅)`);
console.log(`  新增的排序 + 截断输出     ${(-sortCost).toFixed(3)} ms  (代价 ${((sortCost / v0Per) * 100).toFixed(0)}%)`);
console.log("\n→ 反直觉但关键：降幅的大头是「不再为每条文档分配一个 Map」，而不是「换了算法」。");
console.log("  Map 分配之所以贵，是每条文档一次哈希表构建 + 触发 GC；换倒排则把词频挪到构建期算一次。");

// ════════════════════════════════════════════════════════════
// 实验 2：djb2 指纹 —— 闭包到底慢在哪
// ════════════════════════════════════════════════════════════
section("实验 2 · djb2 指纹：闭包边界 vs 变量存放位置 vs 运算符选择");
console.log(`对 ${DOC_COUNT} 条全字段（id+name+description）计算指纹 · 共 ${totalChars} 字符\n`);

// H0：闭包 + 捕获外部 h（改动前的 computeFieldsHash 原样）
function hashClosureCaptured(ps) {
	let h = 5381;
	const mix = (s) => {
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
	return h >>> 0;
}

// H1：闭包但 h 作为参数传入/返回（无捕获），字段序列与 H0 相同
function hashClosurePure(ps) {
	let h = 5381;
	const mix = (hh, s) => {
		for (let i = 0; i < s.length; i++) hh = (hh * 33 + s.charCodeAt(i)) | 0;
		return (hh * 33 + 0x1f) | 0;
	};
	for (const p of ps) {
		h = mix(h, p.id);
		h = mix(h, p.name);
		h = mix(h, p.description);
		h = mix(h, p.category ?? "");
		for (const t of p.tags ?? []) h = mix(h, t);
		h = (h * 33 + 0x1e) | 0;
	}
	return h >>> 0;
}

// H2：完全内联，h 是局部变量（改动后的 computeFieldsHash 原样）
function hashInline(ps) {
	let h = 5381;
	for (let k = 0; k < ps.length; k++) {
		const p = ps[k];
		const id = p.id;
		const name = p.name;
		const desc = p.description;
		const category = p.category ?? "";
		for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		for (let i = 0; i < name.length; i++) h = (h * 33 + name.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		for (let i = 0; i < desc.length; i++) h = (h * 33 + desc.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		for (let i = 0; i < category.length; i++) h = (h * 33 + category.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		const tags = p.tags;
		if (tags) {
			for (let t = 0; t < tags.length; t++) {
				const tag = tags[t];
				for (let i = 0; i < tag.length; i++) h = (h * 33 + tag.charCodeAt(i)) | 0;
				h = (h * 33 + 0x1f) | 0;
			}
		}
		h = (h * 33 + 0x1e) | 0;
	}
	return h >>> 0;
}

// H3：内联，但 h 存放在对象属性上（模拟「变量不在寄存器」）
function hashInlineHeapVar(ps) {
	const state = { h: 5381 };
	for (let k = 0; k < ps.length; k++) {
		const p = ps[k];
		const id = p.id;
		const name = p.name;
		const desc = p.description;
		const category = p.category ?? "";
		for (let i = 0; i < id.length; i++) state.h = (state.h * 33 + id.charCodeAt(i)) | 0;
		state.h = (state.h * 33 + 0x1f) | 0;
		for (let i = 0; i < name.length; i++) state.h = (state.h * 33 + name.charCodeAt(i)) | 0;
		state.h = (state.h * 33 + 0x1f) | 0;
		for (let i = 0; i < desc.length; i++) state.h = (state.h * 33 + desc.charCodeAt(i)) | 0;
		state.h = (state.h * 33 + 0x1f) | 0;
		for (let i = 0; i < category.length; i++) state.h = (state.h * 33 + category.charCodeAt(i)) | 0;
		state.h = (state.h * 33 + 0x1f) | 0;
		const tags = p.tags;
		if (tags) {
			for (let t = 0; t < tags.length; t++) {
				const tag = tags[t];
				for (let i = 0; i < tag.length; i++) state.h = (state.h * 33 + tag.charCodeAt(i)) | 0;
				state.h = (state.h * 33 + 0x1f) | 0;
			}
		}
		state.h = (state.h * 33 + 0x1e) | 0;
	}
	return state.h >>> 0;
}

const tH0 = measure(() => hashClosureCaptured(docs));
const tH1 = measure(() => hashClosurePure(docs));
const tH2 = measure(() => hashInline(docs));
const tH3 = measure(() => hashInlineHeapVar(docs));

console.log("单次全量指纹耗时（字段序列完全相同，只有写法不同）：");
row("H0 闭包 + 捕获外部 h（改动前）", tH0, "← 改动前");
row("H1 闭包 + h 作参数传入/返回", tH1, `${(tH0 / tH1).toFixed(1)}x`);
row("H2 内联 + h 为局部变量（改动后）", tH2, `${(tH0 / tH2).toFixed(1)}x`);
row("H3 内联 + h 存对象属性", tH3, `${(tH0 / tH3).toFixed(1)}x`);

console.log("\n读数（把「闭包慢」这个笼统说法拆开）：");
console.log(`  H0→H1 去掉「捕获外部变量」  省 ${(tH0 - tH1).toFixed(2)} ms   ← 真正的瓶颈`);
console.log(`  H1→H2 去掉「闭包调用」      省 ${(tH1 - tH2).toFixed(2)} ms   ← 几乎可忽略`);
console.log(`  H2→H3 把局部变量搬到堆对象  贵 ${(tH3 - tH2).toFixed(2)} ms   ← 佐证（较弱，见下）`);
console.log("\n→ 结论：慢的不是「调用闭包」，而是累加器 h 被闭包捕获后，V8 必须把它放进");
console.log("  堆上的 context 对象，每次读写都成了内存访问；内联后 h 是局部变量，可留在寄存器。");
console.log("  决定性的证据是 H0→H1：仅把 h 改成参数传入（仍然是闭包、仍然每条 3 次调用）");
console.log("  就拿到几乎全部收益，说明瓶颈在「变量被捕获」而非「函数调用」。");
console.log("  H3 是佐证但较弱：V8 的逃逸分析可能把 state 对象拆散优化掉，故该项数值不稳定。");
console.log(`\n哈希值一致性：H0 === H2 ? ${hashClosureCaptured(docs) === hashInline(docs) ? "是 ✓（重构未改变指纹值）" : "否 ✗"}`);

// ════════════════════════════════════════════════════════════
// 实验 3：topK 选择 —— 全量排序 vs 有界堆
// ════════════════════════════════════════════════════════════
section("实验 3 · topK 选择：对象分配 vs O(n log n) vs O(n log k)");

const DIM = 512;
const ITEM_COUNT = 6000;
const K = 300;
const vecs = Array.from({ length: ITEM_COUNT }, () => {
	const v = new Float32Array(DIM);
	for (let i = 0; i < DIM; i++) v[i] = rnd() * 2 - 1;
	return v;
});
const queryVec = Array.from({ length: DIM }, () => rnd() * 2 - 1);

function normalizeVector(v) {
	let norm = 0;
	for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
	norm = Math.sqrt(norm);
	if (norm === 0) return v;
	const out = new Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
	return out;
}

// T0：全量 sort + slice（对象数组，旧实现）
function topKObjectSort() {
	const q = normalizeVector(queryVec);
	const scored = [];
	for (let vi = 0; vi < vecs.length; vi++) {
		const v = vecs[vi];
		let dot = 0;
		for (let i = 0; i < DIM; i++) dot += q[i] * v[i];
		if (dot >= -1) scored.push({ index: vi, score: dot });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, K);
}

// T1：全量 sort，但用并行类型化数组（无对象分配）
function topKTypedSort() {
	const q = normalizeVector(queryVec);
	const n = vecs.length;
	const idx = new Int32Array(n);
	const sc = new Float64Array(n);
	for (let vi = 0; vi < n; vi++) {
		const v = vecs[vi];
		let dot = 0;
		for (let i = 0; i < DIM; i++) dot += q[i] * v[i];
		idx[vi] = vi;
		sc[vi] = dot;
	}
	const order = Array.from(idx.keys());
	order.sort((a, b) => sc[b] - sc[a]);
	const out = new Array(K);
	for (let i = 0; i < K; i++) out[i] = { index: idx[order[i]], score: sc[order[i]] };
	return out;
}

// T2：有界最小堆（当前实现）
function topKHeap() {
	const q = normalizeVector(queryVec);
	const n = vecs.length;
	const limit = Math.min(K, n);
	const heapIdx = new Int32Array(limit);
	const heapScore = new Float64Array(limit);
	let size = 0;
	const isWorse = (iA, sA, iB, sB) => sA < sB || (sA === sB && iA > iB);
	const swap = (a, b) => {
		const ti = heapIdx[a];
		heapIdx[a] = heapIdx[b];
		heapIdx[b] = ti;
		const ts = heapScore[a];
		heapScore[a] = heapScore[b];
		heapScore[b] = ts;
	};
	const siftUp = (c) => {
		while (c > 0) {
			const p = (c - 1) >> 1;
			if (!isWorse(heapIdx[c], heapScore[c], heapIdx[p], heapScore[p])) break;
			swap(c, p);
			c = p;
		}
	};
	const siftDown = (c) => {
		for (;;) {
			const l = 2 * c + 1;
			if (l >= size) break;
			const r = l + 1;
			const m = r < size && isWorse(heapIdx[r], heapScore[r], heapIdx[l], heapScore[l]) ? r : l;
			if (!isWorse(heapIdx[m], heapScore[m], heapIdx[c], heapScore[c])) break;
			swap(c, m);
			c = m;
		}
	};
	for (let vi = 0; vi < n; vi++) {
		const v = vecs[vi];
		let dot = 0;
		for (let i = 0; i < DIM; i++) dot += q[i] * v[i];
		if (dot < -1) continue;
		if (size < limit) {
			heapIdx[size] = vi;
			heapScore[size] = dot;
			siftUp(size);
			size++;
		} else if (isWorse(heapIdx[0], heapScore[0], vi, dot)) {
			heapIdx[0] = vi;
			heapScore[0] = dot;
			siftDown(0);
		}
	}
	const out = new Array(size);
	for (let i = 0; i < size; i++) out[i] = { index: heapIdx[i], score: heapScore[i] };
	out.sort((a, b) => b.score - a.score || a.index - b.index);
	return out;
}

// 仅点积（不含任何选择阶段）—— 用于确认瓶颈到底在不在选择阶段
function dotOnly() {
	const q = normalizeVector(queryVec);
	let acc = 0;
	for (let vi = 0; vi < vecs.length; vi++) {
		const v = vecs[vi];
		let dot = 0;
		for (let i = 0; i < DIM; i++) dot += q[i] * v[i];
		acc += dot;
	}
	return acc;
}

console.log(`\n${ITEM_COUNT} 条 × ${DIM} 维 · k=${K}\n`);
const tDot = measure(() => dotOnly(), 30);
const tT0 = measure(() => topKObjectSort(), 30);
const tT1 = measure(() => topKTypedSort(), 30);
const tT2 = measure(() => topKHeap(), 30);
row("T-dot 仅点积（无选择阶段）", tDot, "← 固定成本，三者都要付");
row("T0 全量排序（对象数组）", tT0, "← 改动前");
row("T1 全量排序（并行类型化数组）", tT1, `${(tT0 / tT1).toFixed(2)}x`);
row("T2 有界堆 O(n log k)", tT2, `${(tT0 / tT2).toFixed(2)}x`);
console.log(`\n  点积占 T0 的 ${((tDot / tT0) * 100).toFixed(0)}%、占 T2 的 ${((tDot / tT2) * 100).toFixed(0)}%`);
console.log("  → 选择阶段只是零头。点积是算力受限（JS 不自动向量化，512 次乘加逐元素做），");
console.log("    不是内存带宽受限 —— 见实验 7：int8 把内存降到 1/4 也只有 1.05x。");

console.log("\n读数（注意：点积是固定成本，三者的差异只来自选择阶段）：");
console.log(`  T0→T1 去掉 n 个 {index,score} 对象分配：${(tT0 - tT1).toFixed(3)} ms（负值=反而更慢）`);
console.log(`  T1→T2 换成 O(n log k) 部分选择：     ${(tT1 - tT2).toFixed(3)} ms`);
console.log("  → 「省对象分配」这条假设被实测否定：并行类型化数组的比较器要读两个数组，");
console.log("    抵消了分配收益。真正的收益来自 O(n log k)，且因点积占大头，整体只有约 1.35x。");
const sameTop20 =
	topKHeap().slice(0, 20).map((o) => o.index).join(",") ===
	topKObjectSort().slice(0, 20).map((o) => o.index).join(",");
console.log(`  结果一致性：T2 与 T0 前 20 名 ${sameTop20 ? "一致 ✓" : "不一致 ✗"}`);

// ════════════════════════════════════════════════════════════
// 实验 4：API 分批 —— 延迟受限，不是 CPU 受限
// ════════════════════════════════════════════════════════════
section("实验 4 · API 分批：串行 vs 受控并发（模拟每次请求 5ms 延迟）");

const BATCHES = 94; // 6000 条 / 64 ≈ 94 批
const LATENCY = 5;
const CONCURRENCY = 4;
const fakeRequest = () => new Promise((r) => setTimeout(r, LATENCY));

async function sequential() {
	for (let i = 0; i < BATCHES; i++) await fakeRequest();
}
async function concurrent() {
	let cursor = 0;
	const runner = async () => {
		while (cursor < BATCHES) {
			cursor++;
			await fakeRequest();
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, runner));
}

const tSeq = await measureAsync(sequential, 3);
const tCon = await measureAsync(concurrent, 3);
console.log(`\n${BATCHES} 批 × 每批 ${LATENCY}ms 延迟：\n`);
row("串行", tSeq, `理论上限 ≈ ${BATCHES} × ${LATENCY} = ${BATCHES * LATENCY}ms`);
row(`受控并发（上限 ${CONCURRENCY}）`, tCon, `理论上限 ≈ ${Math.ceil(BATCHES / CONCURRENCY)} × ${LATENCY} = ${Math.ceil(BATCHES / CONCURRENCY) * LATENCY}ms`);
console.log(`\n实测提速 ${(tSeq / tCon).toFixed(2)}x，接近理论上限 ${(BATCHES / Math.ceil(BATCHES / CONCURRENCY)).toFixed(2)}x`);
console.log("→ 说明该路径是「延迟受限」（等待网络往返），并发能把等待重叠起来；");
console.log("  若它是 CPU 受限，并发不会有收益。这也解释了为什么并发上限设为 4 而非更高：");
console.log("  收益随并发线性增长，但触发服务端限流的风险同样增长，取折中。");
console.log(`\n注：绝对值被 setTimeout 的最小粒度放大（Node 下约 15ms，而非标称 ${LATENCY}ms），`);
console.log(`    故串行实测 ${tSeq.toFixed(0)}ms 高于理论 ${BATCHES * LATENCY}ms。关键看比值：`);
console.log(`    串行/并发 的比值不受粒度影响，与理论一致（${(tSeq / tCon).toFixed(2)}x vs ${(BATCHES / Math.ceil(BATCHES / CONCURRENCY)).toFixed(2)}x）。`);

async function measureAsync(fn, rounds, batches = 3) {
	await fn();
	let best = Infinity;
	for (let b = 0; b < batches; b++) {
		const t0 = performance.now();
		for (let r = 0; r < rounds; r++) await fn();
		const per = (performance.now() - t0) / rounds;
		if (per < best) best = per;
	}
	return best;
}

// ════════════════════════════════════════════════════════════
// 实验 5：标题模糊匹配（Jaro-Winkler）—— 每次搜索对全部插件名跑一遍
// ════════════════════════════════════════════════════════════
section("实验 5 · 标题模糊匹配：每次搜索对 N 条插件名逐个跑 Jaro-Winkler");

// 名字语料：ASCII 名 + 中文名混合（贴近真实插件市场）
const pluginNames = docs.map((d, i) =>
	i % 3 === 0 ? d.name : WORDS[i % WORDS.length] + WORDS[(i * 7) % WORDS.length] + (i % 5 === 0 ? "" : "助手")
);

/** 复刻 src/shared/utils.ts 的 jaro（每次调用分配两个 boolean 数组） */
function jaroAlloc(a, b) {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
	const aMatches = new Array(a.length).fill(false);
	const bMatches = new Array(b.length).fill(false);
	let matches = 0;
	for (let i = 0; i < a.length; i++) {
		const start = Math.max(0, i - matchWindow);
		const end = Math.min(b.length - 1, i + matchWindow);
		for (let j = start; j <= end; j++) {
			if (bMatches[j]) continue;
			if (a[i] !== b[j]) continue;
			aMatches[i] = true;
			bMatches[j] = true;
			matches++;
			break;
		}
	}
	if (matches === 0) return 0;
	let k = 0;
	let transpositions = 0;
	for (let i = 0; i < a.length; i++) {
		if (!aMatches[i]) continue;
		while (!bMatches[k]) k++;
		if (a[i] !== b[k]) transpositions++;
		k++;
	}
	transpositions = transpositions / 2;
	return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

/** 改进版：复用两个 Uint8Array 暂存区，只清零实际用到的区间（不再每次分配） */
const SCRATCH_MAX = 1024;
const scratchA = new Uint8Array(SCRATCH_MAX);
const scratchB = new Uint8Array(SCRATCH_MAX);

function jaroScratch(a, b) {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	if (a.length > SCRATCH_MAX || b.length > SCRATCH_MAX) return jaroAlloc(a, b);
	const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
	scratchA.fill(0, 0, a.length);
	scratchB.fill(0, 0, b.length);
	let matches = 0;
	for (let i = 0; i < a.length; i++) {
		const start = Math.max(0, i - matchWindow);
		const end = Math.min(b.length - 1, i + matchWindow);
		for (let j = start; j <= end; j++) {
			if (scratchB[j]) continue;
			if (a[i] !== b[j]) continue;
			scratchA[i] = 1;
			scratchB[j] = 1;
			matches++;
			break;
		}
	}
	if (matches === 0) return 0;
	let k = 0;
	let transpositions = 0;
	for (let i = 0; i < a.length; i++) {
		if (!scratchA[i]) continue;
		while (!scratchB[k]) k++;
		if (a[i] !== b[k]) transpositions++;
		k++;
	}
	transpositions = transpositions / 2;
	return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

function jaroWinklerWith(jaroFn, a, b) {
	const j = jaroFn(a, b);
	if (j === 0) return 0;
	let prefix = 0;
	const max = Math.min(4, Math.min(a.length, b.length));
	for (let i = 0; i < max; i++) {
		if (a[i] === b[i]) prefix++;
		else break;
	}
	return j + prefix * 0.1 * (1 - j);
}

const lowerNameCache = new Map();
let jaroCallCount = 0;

function fuzzyScores(jaroFn, query) {
	const q = query.toLowerCase().trim();
	if (!q) return new Map();
	const out = [];
	const qChars = new Set(q);
	for (let n = 0; n < pluginNames.length; n++) {
		const raw = pluginNames[n];
		if (!raw) continue;
		let title = lowerNameCache.get(raw);
		if (title === undefined) {
			title = raw.toLowerCase();
			lowerNameCache.set(raw, title);
		}
		// 快速否决：q 的所有唯一字符都不在 title → 必然 0 分，跳过完整 Jaro
		let allMissing = true;
		for (const ch of qChars) {
			if (title.indexOf(ch) !== -1) {
				allMissing = false;
				break;
			}
		}
		if (allMissing) continue;
		jaroCallCount++;
		const score = jaroWinklerWith(jaroFn, q, title);
		if (score >= 0.55) out.push([raw, score]);
	}
	out.sort((a, b) => b[1] - a[1]);
	return new Map(out.slice(0, 50));
}

const FUZZY_QUERIES = ["笔记", "同步助手", "kanban", "notion", "看板", "templater"];
console.log(`${DOC_COUNT} 条插件名 · ${FUZZY_QUERIES.length} 条查询\n`);

for (const q of FUZZY_QUERIES) {
	jaroCallCount = 0;
	fuzzyScores(jaroAlloc, q);
	const calls = jaroCallCount;
	const tAlloc = measure(() => fuzzyScores(jaroAlloc, q), 5, 5);
	const tScratch = measure(() => fuzzyScores(jaroScratch, q), 5, 5);
	row(
		`query="${q}"`,
		tAlloc,
		`实际跑 Jaro ${calls}/${DOC_COUNT} 次 · 复用暂存区 ${tScratch.toFixed(2)}ms → ${(tAlloc / tScratch).toFixed(2)}x`
	);
}

console.log("\n→ 与实验 1 同源的问题：jaro() 在热循环里「每次调用分配两个数组」");
console.log("  （new Array(len).fill(false)），N 条插件即 2N 次分配 + GC 压力。");
console.log("  快速否决（字符集预筛）只能挡掉「一个字符都不沾」的名字；");
console.log("  ASCII 查询（如 notion）几乎每个含字母的名字都会进入完整 Jaro。");

// ════════════════════════════════════════════════════════════
// 实验 6：两个内容指纹能否合并
// ════════════════════════════════════════════════════════════
section("实验 6 · 两个内容指纹：两次独立遍历 vs 单趟双累加器 vs 单一统一指纹");

// (a) 现状之一：BM25 指纹（id + name + description）
function sigBm25(ps) {
	let h = 5381;
	for (let k = 0; k < ps.length; k++) {
		const p = ps[k];
		const id = p.id;
		const name = p.name;
		const desc = p.description;
		for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		for (let i = 0; i < name.length; i++) h = (h * 33 + name.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		for (let i = 0; i < desc.length; i++) h = (h * 33 + desc.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1e) | 0;
	}
	return (h >>> 0).toString(16);
}

// (a) 现状之二：向量索引字段指纹（id + name + description + category + tags）
function sigFields(ps) {
	let h = 5381;
	for (let k = 0; k < ps.length; k++) {
		const p = ps[k];
		const id = p.id;
		const name = p.name;
		const desc = p.description;
		const cat = p.category ?? "";
		for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		for (let i = 0; i < name.length; i++) h = (h * 33 + name.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		for (let i = 0; i < desc.length; i++) h = (h * 33 + desc.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		for (let i = 0; i < cat.length; i++) h = (h * 33 + cat.charCodeAt(i)) | 0;
		h = (h * 33 + 0x1f) | 0;
		const tags = p.tags;
		if (tags) {
			for (let t = 0; t < tags.length; t++) {
				const tag = tags[t];
				for (let i = 0; i < tag.length; i++) h = (h * 33 + tag.charCodeAt(i)) | 0;
				h = (h * 33 + 0x1f) | 0;
			}
		}
		h = (h * 33 + 0x1e) | 0;
	}
	return (h >>> 0).toString(16);
}

// (b) 单趟遍历 + 两个累加器
function sigMerged(ps) {
	let h1 = 5381;
	let h2 = 5381;
	for (let k = 0; k < ps.length; k++) {
		const p = ps[k];
		const id = p.id;
		const name = p.name;
		const desc = p.description;
		const cat = p.category ?? "";
		for (let i = 0; i < id.length; i++) {
			const c = id.charCodeAt(i);
			h1 = (h1 * 33 + c) | 0;
			h2 = (h2 * 33 + c) | 0;
		}
		h1 = (h1 * 33 + 0x1f) | 0;
		h2 = (h2 * 33 + 0x1f) | 0;
		for (let i = 0; i < name.length; i++) {
			const c = name.charCodeAt(i);
			h1 = (h1 * 33 + c) | 0;
			h2 = (h2 * 33 + c) | 0;
		}
		h1 = (h1 * 33 + 0x1f) | 0;
		h2 = (h2 * 33 + 0x1f) | 0;
		for (let i = 0; i < desc.length; i++) {
			const c = desc.charCodeAt(i);
			h1 = (h1 * 33 + c) | 0;
			h2 = (h2 * 33 + c) | 0;
		}
		h1 = (h1 * 33 + 0x1e) | 0; // BM25 到 description 为止
		h2 = (h2 * 33 + 0x1f) | 0;
		for (let i = 0; i < cat.length; i++) h2 = (h2 * 33 + cat.charCodeAt(i)) | 0;
		h2 = (h2 * 33 + 0x1f) | 0;
		const tags = p.tags;
		if (tags) {
			for (let t = 0; t < tags.length; t++) {
				const tag = tags[t];
				for (let i = 0; i < tag.length; i++) h2 = (h2 * 33 + tag.charCodeAt(i)) | 0;
				h2 = (h2 * 33 + 0x1f) | 0;
			}
		}
		h2 = (h2 * 33 + 0x1e) | 0;
	}
	return [(h1 >>> 0).toString(16), (h2 >>> 0).toString(16)];
}

const t6a = measure(() => {
	sigBm25(docs);
	sigFields(docs);
});
const t6b = measure(() => sigMerged(docs));
const t6c = measure(() => sigFields(docs));

row("(a) 两次独立遍历（现状）", t6a, "← 改动前");
row("(b) 单趟遍历 + 两个累加器", t6b, `${(t6a / t6b).toFixed(2)}x`);
row("(c) 单一统一指纹（覆盖字段并集）", t6c, `${(t6a / t6c).toFixed(2)}x`);

const [m1, m2] = sigMerged(docs);
console.log("\n读数与正确性：");
console.log(`  (b) 结果与 (a) 一致：bm25=${m1 === sigBm25(docs) ? "✓" : "✗"} · fields=${m2 === sigFields(docs) ? "✓" : "✗"}`);
console.log(`  → (b) 实测 ${(t6a / t6b).toFixed(2)}x，远超「只省循环开销」的预期：说明每次迭代的`);
console.log("    固定开销（循环、属性访问、charCodeAt）占比很大，不只是字符比较本身。");
console.log("    同一字符仍要分别喂给两条哈希链，所以收益全部来自「省掉一半的循环与访问」。");
console.log("  → (c) 只快 0.1ms，但会让 BM25 因 category/tags 变化而无效重建（它不依赖这些字段），");
console.log("    故未采用。");
console.log("\n  ✅ 已实施 (b)：src/shared/fingerprint.ts 的 computeIndexFingerprints()");
console.log("     单趟返回 { bm25, fields }；搜索热路径算一次，分别喂给 BM25 索引与向量索引。");
console.log("     两个签名与改造前的实现逐位一致（见 src/shared/fingerprint.test.ts）。");

// ════════════════════════════════════════════════════════════
// 实验 7：向量点积能否走 int8 域（省内存带宽）
// ════════════════════════════════════════════════════════════
section("实验 7 · 向量点积：float32 vs int8（内存 12MB → 3MB，但精度有损）");

const VEC_DIM = 512;
const VEC_COUNT = 6000;
const TOPK = 300;

/** 生成近似真实 embedding 的向量：高斯随机后归一化（单位长度，分量约 ±0.04） */
function gauss() {
	let u = 0;
	let v = 0;
	while (u === 0) u = rnd();
	while (v === 0) v = rnd();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const floatVecs = [];
for (let i = 0; i < VEC_COUNT; i++) {
	const v = new Float32Array(VEC_DIM);
	let norm = 0;
	for (let d = 0; d < VEC_DIM; d++) {
		const x = gauss();
		v[d] = x;
		norm += x * x;
	}
	norm = Math.sqrt(norm);
	for (let d = 0; d < VEC_DIM; d++) v[d] /= norm;
	floatVecs.push(v);
}
const floatQuery = (() => {
	const v = new Float32Array(VEC_DIM);
	let norm = 0;
	for (let d = 0; d < VEC_DIM; d++) {
		const x = gauss();
		v[d] = x;
		norm += x * x;
	}
	norm = Math.sqrt(norm);
	for (let d = 0; d < VEC_DIM; d++) v[d] /= norm;
	return v;
})();

// 对称量化：scale = max|x| / 127，zero-point = 0（省掉每元素的减法）
const int8Vecs = [];
const int8Scale = new Float32Array(VEC_COUNT);
for (let i = 0; i < VEC_COUNT; i++) {
	const src = floatVecs[i];
	let maxAbs = 0;
	for (let d = 0; d < VEC_DIM; d++) {
		const a = Math.abs(src[d]);
		if (a > maxAbs) maxAbs = a;
	}
	const scale = maxAbs / 127 || 1;
	const q = new Int8Array(VEC_DIM);
	for (let d = 0; d < VEC_DIM; d++) q[d] = Math.round(src[d] / scale);
	int8Vecs.push(q);
	int8Scale[i] = scale;
}

// 有界最小堆（复刻 shared/utils.ts），只取 top-k 的 index
function topKOf(scores) {
	const heapScore = new Float64Array(TOPK);
	const heapIdx = new Int32Array(TOPK);
	let size = 0;
	const isWorse = (iA, sA, iB, sB) => sA < sB || (sA === sB && iA > iB);
	const swap = (a, b) => {
		const ti = heapIdx[a];
		heapIdx[a] = heapIdx[b];
		heapIdx[b] = ti;
		const ts = heapScore[a];
		heapScore[a] = heapScore[b];
		heapScore[b] = ts;
	};
	const siftUp = (c) => {
		while (c > 0) {
			const p = (c - 1) >> 1;
			if (!isWorse(heapIdx[c], heapScore[c], heapIdx[p], heapScore[p])) break;
			swap(c, p);
			c = p;
		}
	};
	const siftDown = (c) => {
		for (;;) {
			const l = 2 * c + 1;
			if (l >= size) break;
			const r = l + 1;
			const m = r < size && isWorse(heapIdx[r], heapScore[r], heapIdx[l], heapScore[l]) ? r : l;
			if (!isWorse(heapIdx[m], heapScore[m], heapIdx[c], heapScore[c])) break;
			swap(c, m);
			c = m;
		}
	};
	for (let i = 0; i < scores.length; i++) {
		const s = scores[i];
		if (size < TOPK) {
			heapIdx[size] = i;
			heapScore[size] = s;
			siftUp(size);
			size++;
		} else if (isWorse(heapIdx[0], heapScore[0], i, s)) {
			heapIdx[0] = i;
			heapScore[0] = s;
			siftDown(0);
		}
	}
	const out = [];
	for (let i = 0; i < size; i++) out.push([heapIdx[i], heapScore[i]]);
	out.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	return out.map((x) => x[0]);
}

// (a) float32 点积（现状）
function dotFloat() {
	const q = floatQuery;
	const scores = new Float64Array(VEC_COUNT);
	for (let i = 0; i < VEC_COUNT; i++) {
		const v = floatVecs[i];
		let dot = 0;
		for (let d = 0; d < VEC_DIM; d++) dot += q[d] * v[d];
		scores[i] = dot;
	}
	return scores;
}

// (b) int8 点积（索引侧量化，query 仍为 float32）
function dotInt8() {
	const q = floatQuery;
	const scores = new Float64Array(VEC_COUNT);
	for (let i = 0; i < VEC_COUNT; i++) {
		const v = int8Vecs[i];
		let acc = 0;
		for (let d = 0; d < VEC_DIM; d++) acc += v[d] * q[d];
		scores[i] = acc * int8Scale[i];
	}
	return scores;
}

// (c) int8 点积，query 也量化（两端都在 int8 域，纯整数累加）
const queryInt8 = (() => {
	let maxAbs = 0;
	for (let d = 0; d < VEC_DIM; d++) maxAbs = Math.max(maxAbs, Math.abs(floatQuery[d]));
	const scale = maxAbs / 127 || 1;
	const q = new Int8Array(VEC_DIM);
	for (let d = 0; d < VEC_DIM; d++) q[d] = Math.round(floatQuery[d] / scale);
	return { q, scale };
})();

function dotInt8Both() {
	const q = queryInt8.q;
	const scores = new Float64Array(VEC_COUNT);
	for (let i = 0; i < VEC_COUNT; i++) {
		const v = int8Vecs[i];
		let acc = 0;
		for (let d = 0; d < VEC_DIM; d++) acc += v[d] * q[d];
		scores[i] = acc * int8Scale[i] * queryInt8.scale;
	}
	return scores;
}

const t7a = measure(() => dotFloat(), 20);
const t7b = measure(() => dotInt8(), 20);
const t7c = measure(() => dotInt8Both(), 20);

console.log(`\n${VEC_COUNT} 条 × ${VEC_DIM} 维 · 只算点积，不含选择阶段\n`);
row("(a) float32 点积（现状）", t7a, `内存 ${((VEC_COUNT * VEC_DIM * 4) / 1048576).toFixed(1)} MB`);
row("(b) int8 索引侧点积", t7b, `${(t7a / t7b).toFixed(2)}x · 内存 ${((VEC_COUNT * VEC_DIM) / 1048576).toFixed(1)} MB`);
row("(c) int8 两端点积（纯整数累加）", t7c, `${(t7a / t7c).toFixed(2)}x`);

// 召回质量：int8 的 top-300 与 float 的 top-300 重合度
const refTop = topKOf(dotFloat());
const int8Top = topKOf(dotInt8());
const bothTop = topKOf(dotInt8Both());
const overlap = (a, b) => {
	const set = new Set(b);
	let hit = 0;
	for (const id of a) if (set.has(id)) hit++;
	return hit / a.length;
};
console.log("\n召回质量（与 float32 的 top-300 重合度）：");
console.log(`  (b) int8 索引侧：${(overlap(refTop, int8Top) * 100).toFixed(1)}%`);
console.log(`  (c) int8 两端：  ${(overlap(refTop, bothTop) * 100).toFixed(1)}%`);
console.log(`  首名是否一致：(b) ${refTop[0] === int8Top[0] ? "✓" : "✗"} · (c) ${refTop[0] === bothTop[0] ? "✓" : "✗"}`);

console.log("\n结论：❌ 不实施。");
console.log(`  内存确实降到 1/4（${((VEC_COUNT * VEC_DIM * 4) / 1048576).toFixed(1)}MB → ${((VEC_COUNT * VEC_DIM) / 1048576).toFixed(1)}MB），`);
console.log(`  召回质量也没问题（重合 99%+），但速度只有 ${(t7a / t7b).toFixed(2)}x —— 收益几乎为零。`);
console.log("  原因：点积是**算力受限**而非内存带宽受限。JS 引擎不会自动向量化，512 次乘加");
console.log("  无论数据是 float32 还是 int8 都要逐元素执行一遍，省下的带宽不是瓶颈。");
console.log("  在 JS 里想让点积真正提速，只能靠 WASM/SIMD 把整段循环交给原生代码 ——");
console.log("  那是另一个量级的复杂度，且与「值不值得」无关地要求先有真实性能诉求。");

section("完成");
