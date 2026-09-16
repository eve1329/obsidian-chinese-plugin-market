/**
 * 中文功能词召回评估（词表回归 + 验收）
 *
 * 为什么需要它：`synonyms.ts` 的扩展质量无法只靠「断言结果里包含某个字符串」来判断 ——
 * 真正要回答的是「中文功能词能否召回**正确插件**，且不因为泛词把候选池撑爆」。
 * 本脚本用**生产同一套 BM25 倒排逻辑**（`buildBm25Index` / `bm25RecallScores`）跑真实
 * 插件语料，输出每个查询的命中数与前 10 结果。
 *
 * ⚠️ 相关性判定**只用人 `scripts/eval-ground-truth.ts` 里的显式正例 ID 集**。
 * 早期版本用「包含 image/pdf/writing/graph 等泛词」的正则判相关，等于让脚本自己给自己
 * 打分：`图片压缩` 用 /image|compress|图片|压缩/ 判定时任何图片插件都算命中，
 * 「precision@10 = 10/10」是假的。泛词正则已全部删除 —— 不要加回来。
 * 没有正例集的查询**只报命中数，不给任何精度数字**（避免用不可审计的判据下结论）。
 *
 * 语料口径：`seeded-translator-cache.json` 的中文译名/译文 + 插件 id。
 * 生产语料是「中文译名/译文 + 原始英文名/描述」（见 `view-ai-search.ts` 的
 * `buildSemanticSearchPlugins`，中文在前、英文在后），离线数据里没有英文原文，
 * 故用 kebab-case 的 id 近似补齐英文侧；纯中文语料会低估英文别名的召回。
 * 用 `--zh-only` 可切到纯中文语料对照（注意：该开关只影响**索引文本**；
 * 相关性判定用的是显式正例 ID，不依赖任何文本拼接，因此不存在「评分时仍用 id」的问题）。
 *
 * 运行：`pnpm eval:recall`（先由 esbuild 打包再执行）
 *      `pnpm eval:recall:baseline`（用冻结的改动前词表跑同一套评估，做前后对照）
 */

import { readFileSync } from "node:fs";
import { buildBm25Index, bm25RecallScores } from "@domain/search/ai";
import { expandQuery, expandQueryTerms } from "@translation/lexicon/synonyms";
import { GROUND_TRUTH, groundTruthFor } from "./eval-ground-truth";

interface EvalPlugin {
	id: string;
	name: string;
	description: string;
}

/** 与提示词「四、评估要求」列出的查询保持一致，便于横向对比。 */
const QUERIES = [
	"无限画布",
	"我想找一个无限画布相关的插件",
	"画布",
	"白板",
	"流程图",
	"思维导图",
	"卡片盒",
	"第二大脑",
	"个人知识管理",
	"知识库",
	"甘特图",
	"时间线",
	"任务管理",
	"项目管理",
	"日程安排",
	"工作流自动化",
	"网页剪藏",
	"PDF 标注",
	"文献管理",
	"会议纪要",
	"本地 AI",
	"RAG",
	"语义搜索",
	"向量搜索",
	"闪卡",
	"间隔重复",
	"习惯追踪",
	"图片压缩",
	"代码运行",
	"数据库",
	"双链笔记",
	"读书笔记",
	"知识图谱",
	"卡片笔记",
	"AI 写作",
];

/** 验收查询：有正例集、需要给出 precision/recall 的查询。 */
const ACCEPTANCE = GROUND_TRUTH.map((e) => e.query);

/** 生产 BM25 路径的候选截断（见 ai.ts 的 RECALL_PATH_CAP），recall@N 的上界口径。 */
const RECALL_PATH_CAP = 500;

function loadCorpus(includeId: boolean): EvalPlugin[] {
	const raw = JSON.parse(readFileSync("seeded-translator-cache.json", "utf8")) as {
		cache: Record<string, { translatedName?: string; translatedDesc?: string }>;
	};
	const out: EvalPlugin[] = [];
	for (const [id, t] of Object.entries(raw.cache)) {
		const zhName = (t.translatedName ?? "").trim();
		const zhDesc = (t.translatedDesc ?? "").trim();
		const idText = id.replace(/[-_]/g, " ");
		out.push({
			id,
			name: includeId ? `${zhName} ${idText}`.trim() : zhName || idText,
			description: zhDesc,
		});
	}
	return out;
}

interface QueryResult {
	query: string;
	hits: number;
	ranked: string[];
	/** 正例集（有正例集时才有） */
	positives: Map<string, "strong" | "weak">;
}

function evaluate(corpus: EvalPlugin[], verbose: boolean, onlyAcceptance: boolean): QueryResult[] {
	const t0 = Date.now();
	const index = buildBm25Index(corpus, "eval");
	const buildMs = Date.now() - t0;
	const byId = new Map(corpus.map((p) => [p.id, p]));
	console.log(
		`\n【语料】插件 ${corpus.length} 条 · 索引构建 ${buildMs}ms · 精确短语 ${index.phrasePostings?.size ?? 0} 条 · 正例集覆盖 ${GROUND_TRUTH.length}/${QUERIES.length} 个查询\n`
	);

	const out: QueryResult[] = [];
	for (const q of QUERIES) {
		const gt = groundTruthFor(q);
		if (onlyAcceptance && !gt) continue;
		const ranked = [...bm25RecallScores(q, index, RECALL_PATH_CAP).keys()];
		const positives = new Map<string, "strong" | "weak">(
			gt ? Object.entries(gt.positives).map(([id, v]) => [id, v.relevance]) : []
		);
		out.push({ query: q, hits: ranked.length, ranked, positives });
		if (!verbose) continue;

		const top10 = ranked.slice(0, 10);
		const label = (id: string) => {
			const rel = positives.get(id);
			return rel ? `✓${rel === "strong" ? "" : "弱"}` : "✗";
		};
		console.log(`查询词：${q}`);
		console.log(`扩展后的 query：${expandQuery(q)}`);
		console.log(`扩展词条数：${expandQueryTerms(q).length}`);
		console.log(`BM25 命中数：${ranked.length}`);
		console.log(
			`前 10：${top10.map((id) => `${id}(${byId.get(id)?.name?.slice(0, 12) ?? ""})${label(id)}`).join(" | ") || "（无）"}`
		);

		if (positives.size > 0) {
			const strong = new Set([...positives].filter(([, r]) => r === "strong").map(([id]) => id));
			const hitAt = (n: number, pool: Set<string>) =>
				ranked.slice(0, n).filter((id) => pool.has(id)).length;
			const precAt = (n: number, pool: Set<string>) => {
				const top = ranked.slice(0, n);
				return top.length ? `${hitAt(n, pool)}/${top.length}` : "0/0";
			};
			console.log(
				`正例数：${positives.size}（strong ${strong.size}）· precision@10 = ${precAt(10, new Set(positives.keys()))}（仅 strong：${precAt(10, strong)}）`
			);
			console.log(
				`recall@10 = ${hitAt(10, new Set(positives.keys()))}/${positives.size} · recall@30 = ${hitAt(30, new Set(positives.keys()))}/${positives.size} · recall@100 = ${hitAt(100, new Set(positives.keys()))}/${positives.size} · recall@${RECALL_PATH_CAP} = ${hitAt(ranked.length, new Set(positives.keys()))}/${positives.size}`
			);
			const missed = [...positives.keys()].filter((id) => !ranked.slice(0, 30).includes(id));
			console.log(`前 30 未召回的正例：${missed.length ? missed.join(", ") : "（无）"}`);
			console.log(`前 10 中的非正例：${top10.filter((id) => !positives.has(id)).join(", ") || "（无）"}`);
		}
		console.log("");
	}
	return out;
}

/** markdown 表：有正例集的给 precision/recall，没有的只给命中数。 */
function markdownTable(results: QueryResult[]): void {
	console.log("| 查询词 | 扩展后的 query | BM25 命中数 | 正例数 | precision@10 | recall@10 | recall@30 |");
	console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
	for (const r of results) {
		const top10 = r.ranked.slice(0, 10);
		if (r.positives.size === 0) {
			console.log(`| ${r.query} | \`${expandQuery(r.query)}\` | ${r.hits} | 未标注 | - | - | - |`);
			continue;
		}
		const hit = (n: number) => r.ranked.slice(0, n).filter((id) => r.positives.has(id)).length;
		console.log(
			`| ${r.query} | \`${expandQuery(r.query)}\` | ${r.hits} | ${r.positives.size} | ${top10.filter((id) => r.positives.has(id)).length}/${top10.length} | ${hit(10)}/${r.positives.size} | ${hit(30)}/${r.positives.size} |`
		);
	}
}

/** 验收明细：逐条列出命中/漏召/误召，供人工复核。 */
function acceptanceDetail(results: QueryResult[], byId: Map<string, EvalPlugin>): void {
	for (const r of results) {
		if (r.positives.size === 0) continue;
		const top10 = r.ranked.slice(0, 10);
		const missed30 = [...r.positives.keys()].filter((id) => !r.ranked.slice(0, 30).includes(id));
		console.log(`\n### ${r.query}`);
		console.log(
			`- 正例数 ${r.positives.size}｜命中数 ${r.hits}｜precision@10 ${top10.filter((id) => r.positives.has(id)).length}/10｜recall@10 ${r.ranked.slice(0, 10).filter((id) => r.positives.has(id)).length}｜recall@30 ${r.ranked.slice(0, 30).filter((id) => r.positives.has(id)).length}`
		);
		console.log(
			`- 前 10 命中正例：${top10.filter((id) => r.positives.has(id)).map((id) => `${id}(${r.positives.get(id)})`).join("、") || "（无）"}`
		);
		console.log(
			`- 前 10 误召回：${top10.filter((id) => !r.positives.has(id)).map((id) => `${id}(${byId.get(id)?.name ?? ""})`).join("、") || "（无）"}`
		);
		console.log(`- 前 30 漏召回正例：${missed30.join("、") || "（无）"}`);
	}
}

function main(): void {
	const zhOnly = process.argv.includes("--zh-only");
	const corpus = loadCorpus(!zhOnly);
	const onlyAcceptance = process.argv.includes("--acceptance");
	const md = process.argv.includes("--markdown");
	const results = evaluate(corpus, !md, onlyAcceptance);
	if (md) {
		markdownTable(results);
		return;
	}
	if (onlyAcceptance) acceptanceDetail(results, new Map(corpus.map((p) => [p.id, p])));
}

main();
