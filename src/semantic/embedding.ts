/**
 * 可插拔 Embedding 召回。
 *
 * 设计：把「召回」从「本地关键词」升级为「向量语义」，并做成两档可配 + 自动降级：
 *   1. ApiEmbeddingProvider    —— 复用 OpenAI 兼容 /v1/embeddings 端点（推荐，不占插件体积）
 *   2. LocalEmbeddingProvider  —— 本地模型（transformers.js 跑在 Worker，离线可用）
 *
 * 关键词兜底不在本模块：向量路不可用时由 ai.ts 的 BM25 召回（bm25RecallScores，
 * CJK 三元组倒排）接管，再由 RRF 与标题模糊融合。旧注释写的「localRecall 兜底」
 * 已过时——utils.ts 的 localRecall/localRecallScores 现在只剩测试在用。
 *
 * 向量的数学内核（余弦相似度 / topK）在 utils.ts，纯函数、已单测。
 * 本模块只负责「文本 → 向量」的获取（含 HTTP），以及索引缓存的编排。
 */

import { cosineSimilarity, topKBySimilarity, contentHash, normalizeBaseUrl, normalizeVector, mapWithConcurrency } from "@shared/utils";
import { computeIndexFingerprints } from "@shared/fingerprint";
import { netRequest } from "@data/net/net";
import { WorkerLocalBackend } from "@semantic/workers/worker-backend";
import { t2sForEmbed } from "@translation/lexicon/t2s";

/** Embedding 来源类型（对应设置项） */
export type EmbeddingSource = "api" | "local" | "keyword";

/** Embedding 配置 */
export interface EmbeddingConfig {
	/** OpenAI 兼容 base URL（API 模式）。可与聊天用的 baseURL 不同。 */
	baseURL: string;
	/** API Key（API 模式）。 */
	apiKey: string;
	/** embedding 模型名，如 text-embedding-3-small / nomic-embed-text。 */
	model: string;
	/** 本地模型名（local 模式），如 Xenova/all-MiniLM-L6-v2。 */
	localModel?: string;
	/**
	 * onnxruntime-web wasm 文件的基础路径（local 模式）。
	 * 留空则用 transformers.js 的默认 CDN。可指向自托管/CDN 以加速或离线。
	 */
	localWasmPaths?: string;
}

/**
 * 本地模型推理后端抽象（阶段 2.5）。
 * LocalEmbeddingProvider 不直接依赖 transformers.js，
 * 而是通过一个可注入的 backend 拿到向量 —— 既隔离了重型依赖的加载，
 * 也让测试可以用 FakeBackend 覆盖全部逻辑分支，无需真实下载模型。
 */
export interface LocalModelBackend {
	/** 编码一批文本为归一化向量（行数 = 输入数）。失败抛错。 */
	embed(texts: string[]): Promise<number[][]>;
	/** 后端标识（用于缓存 key 与日志）。 */
	readonly name: string;
	/** 预热（可选）：提前加载模型/初始化，让首次推理免冷启动。失败静默。 */
	warmup?(): Promise<void>;
}

/** 统一的 Embedding 提供者接口 */
export interface EmbeddingProvider {
	readonly name: string;
	/** 批量把文本编码为向量。失败应抛错，交由上层降级。 */
	embed(texts: string[]): Promise<number[][]>;
}

/**
 * Embedding 提供者注册表配置（对应设置项的 embedding 段）。
 * 用单一对象描述「来源 + 该来源所需参数」，让 createEmbeddingProvider
 * 像 vault-curate 的 ProviderRegistry 一样按 source 分派构造，
 * 调用方无需再写 if/else 硬选择 provider。
 */
export interface EmbeddingProviderSpec {
	source: EmbeddingSource;
	/** API 模式：base URL / Key / 模型 */
	baseURL?: string;
	apiKey?: string;
	model?: string;
	/** 本地模式：模型名与 wasm 路径（local backend 用） */
	localModel?: string;
	localWasmPaths?: string;
}

/**
 * 注册表工厂：按 spec.source 构造对应的 EmbeddingProvider。
 *
 * - api   → ApiEmbeddingProvider（OpenAI 兼容 /v1/embeddings）
 * - local → LocalEmbeddingProvider（transformers.js WASM，离线可用）
 *
 * 参数缺失时抛清晰错误（而非静默产出必败请求）。keyword 模式不应走到这里
 * （调用方应直接跳过向量召回），故不在本工厂处理。
 */
export function createEmbeddingProvider(spec: EmbeddingProviderSpec): EmbeddingProvider {
	switch (spec.source) {
		case "api": {
			if (!spec.apiKey || !spec.model) {
				throw new Error("Embedding（API 模式）需填写 API Key 与模型名");
			}
			return new ApiEmbeddingProvider({
				baseURL: spec.baseURL || "https://api.openai.com",
				apiKey: spec.apiKey,
				model: spec.model,
			});
		}
		case "local": {
			return new LocalEmbeddingProvider(
				undefined,
				spec.localModel,
				spec.localWasmPaths
			);
		}
		default:
			throw new Error(`未知的 Embedding 来源：${String(spec.source)}`);
	}
}

/**
 * 生成 embedding 索引/查询缓存的身份标识。
 *
 * 模型名本身不足以标识向量空间：同名模型可能部署在不同的 API 服务上，
 * API 与本地模式也可能恰好使用相同字符串作为模型名。API Key 不参与身份，
 * 避免密钥进入缓存或持久化数据；密钥轮换不会改变向量空间。
 */
export function getEmbeddingIdentity(spec: EmbeddingProviderSpec): string {
	const source = spec.source;
	const model = source === "local"
		? (spec.localModel || DEFAULT_LOCAL_MODEL)
		: (spec.model || "");
	const endpoint = source === "api"
		? normalizeBaseUrl(spec.baseURL || "https://api.openai.com")
		: "";
	return `${source}|${endpoint}|${model}`;
}

/**
 * 基于 OpenAI 兼容 /v1/embeddings 的实现。
 * 请求/响应遵循 OpenAI 规范：
 *   POST {baseURL}/v1/embeddings  { model, input: string[] }
 *   → { data: [{ embedding: number[], index }], ... }
 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
	readonly name = "api";
	/** 单次请求最多编码多少条文本，避免请求体过大 / 超时。 */
	private static readonly BATCH = 64;
	/** 单批初始请求失败后的最大重试次数（总尝试次数 = 1 + MAX_RETRIES）。 */
	private static readonly MAX_RETRIES = 5;
	/** 未提供 Retry-After 时的指数退避起始等待时间。 */
	private static readonly RETRY_BASE_DELAY_MS = 500;
	/** 防止服务端返回过大的 Retry-After 导致一次搜索无限期挂起。 */
	private static readonly RETRY_MAX_DELAY_MS = 30_000;
	/**
	 * 分批请求的并发上限。分批串行时 6000 条 / 64 ≈ 94 个请求排队，索引构建时间
	 * 完全被网络往返主导；受控并发可显著缩短。上限刻意保持克制，避免触发服务端限流。
	 */
	private static readonly CONCURRENCY = 4;

	constructor(private config: EmbeddingConfig) {}

	async embed(texts: string[]): Promise<number[][]> {
		if (!this.config.apiKey) throw new Error("Embedding 未配置 API Key");
		if (!this.config.model) throw new Error("Embedding 未配置模型名");
		if (texts.length === 0) return [];

		const batches: string[][] = [];
		for (let i = 0; i < texts.length; i += ApiEmbeddingProvider.BATCH) {
			batches.push(texts.slice(i, i + ApiEmbeddingProvider.BATCH));
		}

		// 单批在瞬时错误下会先按退避策略重试；重试耗尽后停止派发后续批次，避免
		// 鉴权/限流或持续网络故障时继续把剩余请求打向已经拒绝的服务端。
		// 已经在途的批次自然结束，不再派发新的。
		let aborted = false;
		const results = await mapWithConcurrency(
			batches,
			ApiEmbeddingProvider.CONCURRENCY,
			async (batch) => {
				if (aborted) throw new Error("Embedding 分批已中止（前序批次失败）");
				try {
					return await this.embedBatch(batch);
				} catch (e: unknown) {
					aborted = true;
					throw e;
				}
			}
		);
		// mapWithConcurrency 按 index 回填结果，顺序与输入文本一致
		return results.flat();
	}

	private async embedBatch(batch: string[]): Promise<number[][]> {
		let retry = 0;
		for (;;) {
			let response: Awaited<ReturnType<typeof netRequest>>;
			try {
				response = await netRequest({
					url: `${normalizeBaseUrl(this.config.baseURL)}/v1/embeddings`,
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.config.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: this.config.model,
						input: batch,
					}),
				});
			} catch (e: unknown) {
				// 网络断开、宿主请求超时没有 HTTP 状态码，只能按瞬时故障重试。
				if (retry < ApiEmbeddingProvider.MAX_RETRIES) {
					await this.waitBeforeRetry(retry);
					retry++;
					continue;
				}
				throw e;
			}

			if (response.status < 200 || response.status >= 300) {
				let detail = "";
				try {
					const errJson = response.json as {
						error?: { message?: string };
						message?: string;
					} | null;
					detail = errJson?.error?.message || errJson?.message || "";
				} catch {
					detail = (response.text || "").slice(0, 120);
				}
				if (isRetryableEmbeddingStatus(response.status) && retry < ApiEmbeddingProvider.MAX_RETRIES) {
					await this.waitBeforeRetry(retry, retryAfterMs(response.headers));
					retry++;
					continue;
				}
				throw new Error(
					`Embedding 请求失败 HTTP ${response.status}${detail ? `：${detail}` : ""}`
				);
			}

			interface EmbeddingDataItem {
				index?: number;
				embedding?: unknown;
			}
			const data = (response.json as { data?: EmbeddingDataItem[] | null })?.data;
			if (!Array.isArray(data) || data.length !== batch.length) {
				throw new Error(
					`Embedding 响应格式异常（data 数量 ${Array.isArray(data) ? data.length : 0}，期望 ${batch.length}）`
				);
			}

			const seen = new Set<number>();
			const validated = data.map((item) => {
				// 单条请求兼容少数省略 index 的 OpenAI 兼容实现；批量响应必须显式
				// 提供唯一、连续的 index，否则无法证明向量与输入顺序对应。
				const index = item?.index ?? (batch.length === 1 ? 0 : undefined);
				if (
					!Number.isInteger(index) ||
					(index as number) < 0 ||
					(index as number) >= batch.length ||
					seen.has(index as number)
				) {
					throw new Error("Embedding 响应格式异常（index 缺失、越界或重复）");
				}
				seen.add(index as number);
				const emb = item?.embedding;
				if (
					!Array.isArray(emb) ||
					emb.length === 0 ||
					emb.some((value) => typeof value !== "number" || !Number.isFinite(value))
				) {
					throw new Error("Embedding 响应缺少有效 embedding 向量");
				}
				return { index: index as number, embedding: emb as number[] };
			});

			if (seen.size !== batch.length) {
				throw new Error("Embedding 响应格式异常（index 不完整）");
			}
			// 按 index 排序，保证与输入顺序一致
			validated.sort((a, b) => a.index - b.index);
			return validated.map((item) => item.embedding);
		}
	}

	private async waitBeforeRetry(retry: number, retryAfter?: number): Promise<void> {
		const fallback = ApiEmbeddingProvider.RETRY_BASE_DELAY_MS * (2 ** retry);
		const delay = Math.min(
			ApiEmbeddingProvider.RETRY_MAX_DELAY_MS,
			Math.max(0, retryAfter ?? fallback),
		);
		await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
	}
}

function isRetryableEmbeddingStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** 解析 Retry-After 的秒数或 HTTP-date；异常/负值交给指数退避。 */
function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
	if (!headers) return undefined;
	const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1]?.trim();
	if (!raw) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const at = Date.parse(raw);
	if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
	return undefined;
}

/**
 * 本地模型 Embedding 提供者（阶段 2.5）。
 *
 * 通过注入的 LocalModelBackend 获取向量，自身只负责：
 *   - 输入切片（避免一次喂太多文本导致 OOM / 超时）；
 *   - 调用 backend 并原样返回向量；
 *   - 任何失败抛清晰错误，交由 aiSearch 降级到关键词召回。
 *
 * 默认 backend 为 WorkerLocalBackend：把 transformers 跑在 Web Worker 里（绕开
 * Obsidian 沙箱对 node_modules 的原生 import 限制，见 workers/worker-backend.ts）。
 * 首次需联网从 CDN 拉取模型权重并缓存；离线可用。
 * 测试时传入 FakeBackend 即可覆盖全部逻辑分支，无需真实下载。
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
	readonly name = "local";
	/** 单次送入后端的文本上限，避免大批量时内存峰值过高。 */
	private static readonly BATCH = 32;
	private readonly backend: LocalModelBackend;

	/**
	 * @param backend 本地推理后端；不传则构造默认的 WorkerLocalBackend。
	 * @param model   本地模型名（透传给 backend）。
	 * @param wasmPaths onnx wasm 路径（透传给 backend，WASM 回退路径用）。
	 */
	constructor(
		backend?: LocalModelBackend,
		model = DEFAULT_LOCAL_MODEL,
		wasmPaths?: string
	) {
		// 默认用共享实例（同 model 单例）：复用同一 worker，模型只加载一次，避免每次搜索冷启动
		this.backend = backend ?? WorkerLocalBackend.getShared({ model, wasmPaths });
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += LocalEmbeddingProvider.BATCH) {
			const batch = texts.slice(i, i + LocalEmbeddingProvider.BATCH);
			const vecs = await this.backend.embed(batch);
			for (const v of vecs) out.push(v);
		}
		return out;
	}

	/** 预热：提前加载本地模型（对齐 vault-curate 的 warmup），让首次搜索免冷启动。 */
	async warmup(): Promise<void> {
		await this.backend.warmup?.();
	}
}

/**
 * 默认本地模型：bge-small-zh-v1.5（面向中文语义，vault-curate 同款）。
 * 相比 all-MiniLM-L6-v2 对中文的同义词/口语/专业术语召回更准；体积略大（~110MB）。
 */
export const DEFAULT_LOCAL_MODEL = "Xenova/bge-small-zh-v1.5";

/** 当前环境是否暴露 WebGPU（仅影响本地 embedding 是否走 GPU 加速；不可用则回退 WASM） */
export function isWebGPUAvailable(): boolean {
	try {
		const nav = navigator as unknown as { gpu?: unknown };
		return typeof navigator !== "undefined" && !!nav.gpu;
	} catch {
		return false;
	}
}

/** 向量索引：插件 id 顺序 + 对应向量 + 内容指纹（用于判断是否需重建）。 */
export interface VectorIndex {
	ids: string[];
	/** 每条向量。可为 number[]（测试/手写构造）或 Float32Array（getAllVecs
	 *  反量化产出）。召回时直接复用 Float32Array，避免 Array.from 二次转换。 */
	vectors: (number[] | Float32Array)[];
	hash: string;
	/** 生成该索引的 embedding 模型名，模型变更时需重建。 */
	model: string;
	/** 生成该索引的来源/endpoint/model 身份，防止同名模型跨服务复用。 */
	embeddingIdentity?: string;
	/**
	 * 分类体系版本号（用法 A 注入 category/tags 时）。
	 * 当分类体系大改（重命名/合并 category）但恰好文本指纹未变时，
	 * 仅凭 hash 无法察觉失效；此字段强制重建，保证索引与分类知识同步。
	 * 未注入分类维度时留空（仅靠 hash 兜底）。
	 */
	categorySchemaVersion?: string;
	/** 每条文本的内容指纹（id → hash），用于增量更新：同 id 同 hash 则复用向量，不再重 embed。 */
	perIdHash?: Record<string, string>;
	/**
	 * 原始字段指纹（id+name+description+category+tags，不含 t2s 转换与文本拼装）。
	 * 用于稳态搜索的「零成本复用判定」：fieldsHash 一致即代表文本拼装 + t2s 结果
	 * 必然不变，可跳过全库文本拼装 / t2s / contentHash 直接复用（PERF-2）。
	 * 与 perIdHash 一样持久化到 SQLite；旧索引缺失时在整体 hash 相等分支回填。
	 */
	fieldsHash?: string;
}

/** 构建索引的单条插件输入：基础字段 + 可选分类维度（用法 A）。 */
export interface IndexPlugin {
	id: string;
	name: string;
	description: string;
	/** 一级功能分类（强锚点，放在句首）。无则不注入。 */
	category?: string;
	/** 功能/场景标签（弱信号，尾随）。无则不注入。 */
	tags?: string[];
}

/**
 * 用给定 provider 为插件列表构建向量索引。
 * 若传入 prevIndex 且内容指纹 + 模型 + 分类 schema 版本均未变化，则直接复用，
 * 避免重复 API 调用。
 *
 * 用法 A：把分类维度注入召回。每条文本的拼装为：
 *   分类：<category>
 *   <name>
 *   <description>
 *   标签：<tags 用空格 join>
 * - category 句首强锚点（主导向量方向），tags 尾随弱信号（微调同分类内偏好）。
 * - 文本变化 → hash 自然变化 → 旧索引自动重建（首次搜索重 embed 一次）。
 *
 * @param precomputedFieldsHash 调用方若已算过字段指纹可直接传入，省掉本函数内的全库遍历。
 *   搜索热路径（AISearcher）会一次遍历同时算出 BM25 与向量两个指纹后传入；
 *   未传时（如启动期的一次性后台预建）在本函数内自算，行为不变。
 */
export async function buildVectorIndex(
	provider: EmbeddingProvider,
	plugins: IndexPlugin[],
	model: string,
	prevIndex?: VectorIndex | null,
	categorySchemaVersion?: string,
	precomputedFieldsHash?: string,
	embeddingIdentity?: string
): Promise<VectorIndex> {
	// 稳态快速短路：先对「原始字段」算轻量指纹（不做 t2s / 文本拼装 / perIdHash），
	// 与 prevIndex.fieldsHash 一致即代表最终文本必然不变，直接复用整个索引（PERF-2）。
	// 这一步把每次搜索的全库 t2s + contentHash 重算（数十 ms）降为一次单趟 djb2 遍历
	// （实测约 1ms）；该指纹还与 BM25 索引的失效签名合并为同一次遍历，见 shared/fingerprint.ts。
	const fieldsHash = precomputedFieldsHash ?? computeFieldsHash(plugins);
	if (
		prevIndex &&
		prevIndex.fieldsHash === fieldsHash &&
		prevIndex.model === model &&
		prevIndex.embeddingIdentity === embeddingIdentity &&
		prevIndex.categorySchemaVersion === categorySchemaVersion &&
		prevIndex.ids.length === plugins.length
	) {
		return prevIndex;
	}

	const rawTexts = plugins.map((p) => {
		const parts: string[] = [];
		if (p.category && p.category.trim()) {
			parts.push(`分类：${p.category.trim()}`);
		}
		parts.push(p.name);
		parts.push(p.description);
		const tagStr = (p.tags ?? [])
			.filter((t) => t && t.trim())
			.join(" ");
		if (tagStr) {
			parts.push(`标签：${tagStr}`);
		}
		return parts.join("\n").slice(0, 512);
	});
	// 繁→简统一到 bge-small-zh 最擅长的简体空间（借鉴 vault-curate：只转 embed 输入）
	const texts = rawTexts.map((t) => t2sForEmbed(t));
	const hash = contentHash(texts);
	// 每条文本的内容指纹（增量更新依据）
	const perIdHash: Record<string, string> = {};
	for (let i = 0; i < plugins.length; i++) perIdHash[plugins[i].id] = contentHash([texts[i]]);

	// 快速路径：整体未变，直接复用（保持同一引用，满足 toBe 语义）
	if (
		prevIndex &&
		prevIndex.hash === hash &&
		prevIndex.model === model &&
		prevIndex.embeddingIdentity === embeddingIdentity &&
		prevIndex.categorySchemaVersion === categorySchemaVersion &&
		prevIndex.ids.length === plugins.length
	) {
		// 补齐 perIdHash（旧索引可能没有）
		if (!prevIndex.perIdHash) prevIndex.perIdHash = perIdHash;
		// SQLite 旧索引不保存 fieldsHash；整体 hash 已确认一致时回填，
		// 避免冷启动后每次搜索重复做全库文本拼装 / t2s / 指纹计算。
		if (prevIndex.fieldsHash !== fieldsHash) prevIndex.fieldsHash = fieldsHash;
		return prevIndex;
	}

	// 增量更新（你朋友建议的「embedding 与搜索分离 + 增量」）：
	// 只重 embed「新增的 id」和「内容指纹变化的 id」，未变的直接复用 prevIndex 的向量。
	// 但 categorySchemaVersion 变化时强制全量重建（分类语义可能变了，即使文本 hash 未变，
	// 注入分类的向量也应重建——否则分类知识变更无法生效）。
	const schemaChanged = prevIndex?.categorySchemaVersion !== categorySchemaVersion;
	const embeddingIdentityChanged = prevIndex?.embeddingIdentity !== embeddingIdentity;

	const prevVecById = new Map<string, number[] | Float32Array>();
	if (prevIndex) {
		for (let i = 0; i < prevIndex.ids.length; i++) {
			prevVecById.set(prevIndex.ids[i], prevIndex.vectors[i]);
		}
	}

	// 需要重 embed 的索引（在 plugins 中的位置）
	const needEmbed: number[] = [];
	const vectors = new Array<number[] | Float32Array>(plugins.length);
	for (let i = 0; i < plugins.length; i++) {
		const id = plugins[i].id;
		const prev = prevVecById.get(id);
		// 复用条件：有旧向量 + 模型一致 + 分类 schema 未变 + 该条 hash 未变
		if (
			prev &&
			!schemaChanged &&
			!embeddingIdentityChanged &&
			prevIndex?.model === model &&
			prevIndex?.perIdHash?.[id] === perIdHash[id]
		) {
			vectors[i] = prev;
		} else {
			needEmbed.push(i);
		}
	}

	if (needEmbed.length > 0) {
		const embedTexts = needEmbed.map((i) => texts[i]);
		const newVecs = await provider.embed(embedTexts);
		for (let k = 0; k < needEmbed.length; k++) {
			// 归一化后包成 Float32Array，统一索引载体，召回时免去 Array.from 二次转换
			vectors[needEmbed[k]] = Float32Array.from(normalizeVector(newVecs[k]));
		}
	}

	return {
		ids: plugins.map((p) => p.id),
		vectors,
		hash,
		model,
		embeddingIdentity,
		categorySchemaVersion,
		perIdHash,
		fieldsHash,
	};
}

/**
 * 向量索引的字段指纹（id+name+description+category+tags）。
 *
 * 委托给 shared/fingerprint 的单趟实现，避免两处各写一份哈希逻辑而悄悄漂移。
 * 本函数只作为「调用方未预计算」时的兜底（如启动期一次性后台预建）——搜索热路径
 * 会传入预计算值，见 buildVectorIndex 的 precomputedFieldsHash 参数。
 */
function computeFieldsHash(plugins: IndexPlugin[]): string {
	return computeIndexFingerprints(plugins, (p) => p).fields;
}

/**
 * 向量召回：把 query embed 后，在索引中取 topK 最相似的插件 id。
 * @returns 命中的插件 id 列表（降序）。索引为空或 query 向量缺失时返回空。
 */
export async function vectorRecall(
	provider: EmbeddingProvider,
	query: string,
	index: VectorIndex,
	k: number,
	minScore = -1
): Promise<string[]> {
	const m = await vectorRecallScores(provider, query, index, k, minScore);
	return m ? Array.from(m.keys()) : [];
}

/** query embedding LRU 缓存（PERF-9）：命中则跳过重复 embed（省一次 API 往返/推理）。 */
const QUERY_VEC_CACHE = new Map<string, number[]>();
const QUERY_VEC_CACHE_MAX = 64;

/**
 * query 向量缓存键。
 *
 * 必须同时含 provider 类型**和实际模型**：`EmbeddingProvider.name` 只有 "api"/"local"
 * 两种取值，不含模型。若只用 name 作键，用户在同一 provider 类型下换模型
 * （如 text-embedding-3-small → text-embedding-3-large，1536 → 3072 维）后会命中
 * 旧模型的向量；而 topKBySimilarity 对维度不一致是「按较短维度截断」的静默行为，
 * 不抛错、不告警，直接给出错误排序。
 *
 * 这里用 index.model 和 index.embeddingIdentity（构建该索引时的完整身份）而非
 * provider 内部字段：索引与 query 必须落在同一向量空间，以索引身份为准是最直接的不变量。
 */
function queryVecCacheKey(
	provider: EmbeddingProvider,
	model: string,
	query: string,
	embeddingIdentity?: string,
): string {
	return `${provider.name}|${embeddingIdentity ?? ""}|${model}|${query}`;
}

function getCachedQueryVec(key: string): number[] | undefined {
	const hit = QUERY_VEC_CACHE.get(key);
	if (hit) {
		// LRU：命中后移到末尾（最近使用）
		QUERY_VEC_CACHE.delete(key);
		QUERY_VEC_CACHE.set(key, hit);
	}
	return hit;
}

function setCachedQueryVec(key: string, vec: number[]): void {
	if (QUERY_VEC_CACHE.has(key)) QUERY_VEC_CACHE.delete(key);
	QUERY_VEC_CACHE.set(key, vec);
	// 超出容量：淘汰最久未用（Map 迭代序 = 插入序，首个即最旧）
	if (QUERY_VEC_CACHE.size > QUERY_VEC_CACHE_MAX) {
		const oldest = QUERY_VEC_CACHE.keys().next().value;
		if (oldest !== undefined) QUERY_VEC_CACHE.delete(oldest);
	}
}

/** 测试专用：清空 query embedding 缓存（模块级缓存在测试间会泄漏状态）。 */
export function __clearQueryVecCacheForTest(): void {
	QUERY_VEC_CACHE.clear();
}

/**
 * 向量召回（带分数版）：同 vectorRecall，但返回 `Map<插件id, 余弦相似度>`，
 * 供上层做 RRF 融合（而非简单并集）。索引为空或 query 向量缺失时返回 null。
 */
export async function vectorRecallScores(
	provider: EmbeddingProvider,
	query: string,
	index: VectorIndex,
	k: number,
	minScore = -1
): Promise<Map<string, number> | null> {
	if (!index.vectors.length) return null;
	// query 同样转简体（与索引同空间）。PERF-9：命中缓存则跳过重复 embed（省一次 API 往返/推理）。
	// 键含完整 embedding identity，保证换模型或 endpoint 后不会复用旧向量（见 queryVecCacheKey）。
	const t2sQuery = t2sForEmbed(query);
	const cacheKey = queryVecCacheKey(provider, index.model, t2sQuery, index.embeddingIdentity);
	let queryVec = getCachedQueryVec(cacheKey);
	if (!queryVec) {
		const [vec] = await provider.embed([t2sQuery]);
		queryVec = vec;
		if (queryVec && queryVec.length > 0) setCachedQueryVec(cacheKey, queryVec);
	}
	if (!queryVec || queryVec.length === 0) return null;
	const top = topKBySimilarity(queryVec, index.vectors, k, minScore);
	const m = new Map<string, number>();
	for (const t of top) {
		if (t.index >= 0 && t.index < index.ids.length) {
			m.set(index.ids[t.index], t.score);
		}
	}
	return m;
}

// 便于其它模块复用（避免重复 import 路径）
export { cosineSimilarity, topKBySimilarity };
