/**
 * 搜索索引的内容指纹（djb2，非加密）。
 *
 * 背景：搜索链路上有两个独立缓存的索引，各自需要「内容是否变化」的判定：
 *   - BM25 索引（ai.ts）只依赖 id / name / description；
 *   - 向量索引（embedding.ts）还依赖 category / tags（作为 embedding 输入的锚点）。
 * 原先两者各写一份遍历函数，每次搜索各跑一遍全量（6000 条 × 约 440k 字符）。
 *
 * 这里合并为**单趟遍历 + 两个累加器**。刻意不用单一累加器：两个索引的字段集不同，
 * 共用一个指纹会让 BM25 因 category/tags 变化而无效重建（它并不依赖这些字段）。
 *
 * 实测（6000 条，跑 scripts/bench-search-perf.mjs 实验 6 可复现）：两次独立遍历
 * 约 1.9~2.3ms → 单趟双累加器约 1.1~1.2ms（约 1.7~1.9x，随机器波动）。收益主要
 * 来自省掉一半的循环与属性访问开销，而非字符比较本身——同一字符仍要分别喂给两条
 * 哈希链。这个幅度超出预期，说明每次迭代的固定开销占比很大。
 *
 * 用 tagsOf 访问器而非要求调用方先构造「带分类的插件对象」：后者每次搜索要分配
 * 6000 个临时对象，正是本项目刚在 BM25 上修掉的反模式。
 */

/** 指纹输入：所有索引共有的基础字段 */
export interface FingerprintInput {
	id: string;
	name: string;
	description: string;
}

/** 分类/标签信息 */
export interface FingerprintTags {
	category?: string;
	tags?: string[];
}

/** 两个索引各自的失效签名 */
export interface IndexFingerprints {
	/** 覆盖 id/name/description —— BM25 索引的失效判定 */
	bm25: string;
	/** 覆盖 id/name/description/category/tags —— 向量索引的失效判定 */
	fields: string;
}

/** 字段分隔符（避免 ["ab","c"] 与 ["a","bc"] 拼出同一串） */
const FIELD_SEP = 0x1f;
/** 条目分隔符 */
const ITEM_SEP = 0x1e;

/**
 * 单趟遍历算出两个索引的失效签名。
 *
 * @param items  插件基础字段（id/name/description）
 * @param tagsOf 分类/标签访问器；不传则 fields 签名只覆盖基础字段
 *               （等价于所有插件都没有 category/tags）
 */
export function computeIndexFingerprints<T extends FingerprintInput>(
	items: T[],
	tagsOf?: (item: T) => FingerprintTags | undefined
): IndexFingerprints {
	let bm25 = 5381;
	let fields = 5381;

	for (let k = 0; k < items.length; k++) {
		const item = items[k];
		const id = item.id;
		const name = item.name;
		const desc = item.description;

		// id / name / description 是两个索引共有的前缀：同一字符喂给两条链
		for (let i = 0; i < id.length; i++) {
			const c = id.charCodeAt(i);
			bm25 = (bm25 * 33 + c) | 0;
			fields = (fields * 33 + c) | 0;
		}
		bm25 = (bm25 * 33 + FIELD_SEP) | 0;
		fields = (fields * 33 + FIELD_SEP) | 0;

		for (let i = 0; i < name.length; i++) {
			const c = name.charCodeAt(i);
			bm25 = (bm25 * 33 + c) | 0;
			fields = (fields * 33 + c) | 0;
		}
		bm25 = (bm25 * 33 + FIELD_SEP) | 0;
		fields = (fields * 33 + FIELD_SEP) | 0;

		for (let i = 0; i < desc.length; i++) {
			const c = desc.charCodeAt(i);
			bm25 = (bm25 * 33 + c) | 0;
			fields = (fields * 33 + c) | 0;
		}
		// BM25 链到此为止；fields 链继续吸收分类维度
		bm25 = (bm25 * 33 + ITEM_SEP) | 0;
		fields = (fields * 33 + FIELD_SEP) | 0;

		const tagInfo = tagsOf?.(item);
		const category = tagInfo?.category ?? "";
		for (let i = 0; i < category.length; i++) {
			fields = (fields * 33 + category.charCodeAt(i)) | 0;
		}
		fields = (fields * 33 + FIELD_SEP) | 0;

		const tags = tagInfo?.tags;
		if (tags) {
			for (let t = 0; t < tags.length; t++) {
				const tag = tags[t];
				for (let i = 0; i < tag.length; i++) {
					fields = (fields * 33 + tag.charCodeAt(i)) | 0;
				}
				fields = (fields * 33 + FIELD_SEP) | 0;
			}
		}
		fields = (fields * 33 + ITEM_SEP) | 0;
	}

	return { bm25: (bm25 >>> 0).toString(16), fields: (fields >>> 0).toString(16) };
}
