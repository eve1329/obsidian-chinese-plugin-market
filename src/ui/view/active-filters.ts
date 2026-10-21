/**
 * 活跃筛选维度的【单一事实来源】。
 *
 * 背景：此前「哪些筛选维度算生效」这份清单在视图层被手工维护了四处，且各漏不同维度——
 *   1. `renderActiveFilters`（顶部常驻 chips）只收 4 类 → 收起面板后用户看不到任何提示；
 *   2. `updateFacetVisibility` 的 `hasActive`（重置按钮高亮）只判 5 项；
 *   3. 空态「清除筛选」按钮只清 4 个维度，却把所有胶囊 `aria-pressed` 置 false → 界面说谎；
 *   4. 渲染签名 `filterState` 只编 5 个维度 → 点了筛选但列表不更新（概率性，最难自查）。
 *
 * 收敛成本模块后，上述四处全部从这里派生，新增筛选维度只需在本文件加一项。
 *
 * 设计约定：
 * - `clear()` 只改状态 + 持久化，【不】做视觉同步、【不】触发渲染；
 * - 视觉同步统一由 `ctx.updateFacetVisibility()` 完成（它被包装为「基础逻辑 + syncFilterChips()」，
 *   而 syncFilterChips 会调用全部 update*Toggle，见 view-toolbar.ts）；
 * - 渲染收尾统一由调用方做一次，避免 N 个维度触发 N 次重渲染。
 */

import type { ViewContext } from "@ui/view/view-context";
import type { I18nKey } from "@shared/i18n";

/** 一个生效中的筛选维度 */
export interface ActiveFilter {
	/** 维度唯一 key */
	key: string;
	/** chip 展示文案（形如「分类：XX」时 chips 会拆成 key/value 两段） */
	label: string;
	/** 当前值（渲染签名用：保证输入变则签名必变） */
	value: string;
	/** 只改状态 + 持久化；不触发视觉同步与渲染 */
	clear: () => void;
}

/* ── 窗口类筛选的常量（从 view-toolbar 上移，保证 chips 与胶囊口径一致） ── */

export const NEW_WINDOWS = [1, 3, 7, 30, 90, 365] as const;
export const NEW_LABELS = ["24h", "3天", "7天", "30天", "90天", "1年"];

export const UPD_OPTIONS = [
	{ days: 30, dir: "within", label: "30天内有更新" },
	{ days: 90, dir: "within", label: "90天内有更新" },
	{ days: 365, dir: "within", label: "1年内有更新" },
	{ days: 365, dir: "beyond", label: "超1年未更新" },
	{ days: 730, dir: "beyond", label: "超2年未更新" },
] as const;

export const updValue = (o: (typeof UPD_OPTIONS)[number]): number => (o.dir === "within" ? o.days : -o.days);

const UPD_LABEL: Record<number, string> = Object.fromEntries(
	UPD_OPTIONS.map((o) => [updValue(o), o.label]),
);

const INSTALL_LABEL: Record<string, string> = {
	installed: "已安装",
	enabled: "已启动",
	installedNotEnabled: "已安装未启动",
};

const FAV_LABEL: Record<string, string> = {
	favorited: "已收藏",
	unfavorited: "未收藏",
};

/**
 * 当前生效的筛选维度清单（按固定顺序，保证签名稳定）。
 *
 * 每个维度都自带 `clear()`，因此「清除单个」与「清除全部」共用同一套逻辑，
 * 不会再出现「chips 能清但重置按钮漏清」这类口径漂移。
 */
export function activeFilters(ctx: ViewContext): ActiveFilter[] {
	const out: ActiveFilter[] = [];

	// 1) 翻译来源（持久化）
	if (ctx.sourceFilter !== "all") {
		const label = ctx.t(`settings.prefs.sourceFilter.${ctx.sourceFilter}` as I18nKey);
		out.push({
			key: "source",
			label: ctx.t("filter.active.source", { value: label }),
			value: ctx.sourceFilter,
			clear: () => {
				ctx.sourceFilter = "all";
				ctx.settings.sourceFilter = "all";
				ctx.saveSettings();
			},
		});
	}

	// 2) 安装状态
	if (ctx.installFilter !== "all") {
		out.push({
			key: "install",
			label: INSTALL_LABEL[ctx.installFilter] ?? ctx.installFilter,
			value: ctx.installFilter,
			clear: () => {
				ctx.installFilter = "all";
			},
		});
	}

	// 3) 官方推荐
	if (ctx.recommendedOnly) {
		out.push({
			key: "recommended",
			label: ctx.t("filter.active.recommended"),
			value: "1",
			clear: () => {
				ctx.recommendedOnly = false;
			},
		});
	}

	// 4) 收藏筛选
	if (ctx.favoriteFilter !== "all") {
		out.push({
			key: "favorite",
			label: FAV_LABEL[ctx.favoriteFilter] ?? ctx.favoriteFilter,
			value: ctx.favoriteFilter,
			clear: () => {
				ctx.favoriteFilter = "all";
			},
		});
	}

	// 5) 作者
	if (ctx.authorFilter !== null) {
		out.push({
			key: "author",
			label: ctx.t("filter.active.author", { value: ctx.authorFilter }),
			value: ctx.authorFilter,
			clear: () => {
				ctx.authorFilter = null;
				// 作者 facet 的选中态由本模块渲染，需显式刷新
				ctx.renderAuthorFacet();
			},
		});
	}

	// 6) 分类（多选，每项一个 chip）
	for (const cat of ctx.selectedCategories) {
		out.push({
			key: "category",
			label: ctx.t("filter.active.category", { value: cat }),
			value: cat,
			clear: () => {
				const idx = ctx.selectedCategories.indexOf(cat);
				if (idx >= 0) ctx.selectedCategories.splice(idx, 1);
			},
		});
	}

	// 7) 中文生态
	if (ctx.chineseEcoFilter !== "all") {
		out.push({
			key: "eco",
			label: ctx.t("filter.active.eco"),
			value: ctx.chineseEcoFilter,
			clear: () => {
				ctx.chineseEcoFilter = "all";
			},
		});
	}

	// 8) 系列
	if (ctx.seriesFilter !== "all") {
		const isBamboo = ctx.seriesFilter === "bamboo";
		out.push({
			key: "series",
			label: ctx.t(isBamboo ? "filter.active.series.bamboo" : "filter.active.series.yulin"),
			value: ctx.seriesFilter,
			clear: () => {
				ctx.seriesFilter = "all";
			},
		});
	}

	// 9) 新上线窗口（持久化）
	if (ctx.newWithinDays !== null) {
		const idx = NEW_WINDOWS.indexOf(ctx.newWithinDays as (typeof NEW_WINDOWS)[number]);
		const label = idx >= 0 ? NEW_LABELS[idx] : String(ctx.newWithinDays);
		out.push({
			key: "new",
			label: ctx.t("filter.active.new", { value: label }),
			value: String(ctx.newWithinDays),
			clear: () => {
				ctx.newWithinDays = null;
				ctx.settings.newWithinDays = null;
				ctx.saveSettings();
			},
		});
	}

	// 10) 更新时间窗口（持久化）
	if (ctx.updatedWithinDays !== null) {
		const v = ctx.updatedWithinDays;
		const label = UPD_LABEL[v] ?? (v > 0 ? `近 ${v} 天内有更新` : `超 ${Math.abs(v)} 天未更新`);
		out.push({
			key: "updated",
			label: ctx.t("filter.active.updated", { value: label }),
			value: String(v),
			clear: () => {
				ctx.updatedWithinDays = null;
				ctx.settings.updatedWithinDays = null;
				ctx.saveSettings();
			},
		});
	}

	// 11) 评测台账三维度（当前无对应胶囊 UI，但作为兜底必须纳入：
	//     否则一旦被持久化/程序化置上，用户将看到列表变少却无任何提示与清除入口）
	if (ctx.triedFilter !== "all") {
		out.push({
			key: "tried",
			label: ctx.t("filter.active.tried"),
			value: ctx.triedFilter,
			clear: () => {
				ctx.triedFilter = "all";
			},
		});
	}

	if (ctx.abandonedFilter !== "all") {
		out.push({
			key: "abandoned",
			label: ctx.t("filter.active.abandoned"),
			value: ctx.abandonedFilter,
			clear: () => {
				ctx.abandonedFilter = "all";
			},
		});
	}

	if (ctx.verdictFilter !== "all") {
		out.push({
			key: "verdict",
			label: ctx.t("filter.active.verdict", { value: ctx.verdictFilter }),
			value: ctx.verdictFilter,
			clear: () => {
				ctx.verdictFilter = "all";
			},
		});
	}

	return out;
}

/** 清除单个维度并统一收尾（chips 的 ✕ 用） */
export function clearOneFilter(ctx: ViewContext, f: ActiveFilter): void {
	f.clear();
	refreshAfterFilterChange(ctx);
}

/** 清除全部筛选维度并统一收尾（空态「清除筛选」/工具栏「重置」用） */
export function clearAllFilters(ctx: ViewContext): void {
	activeFilters(ctx).forEach((f) => f.clear());
	refreshAfterFilterChange(ctx);
}

/**
 * 渲染签名用的筛选维度摘要。
 * 直接由本模块派生，从机制上保证「任何筛选输入变了签名必变」——
 * 不再依赖视图层手工维护维度清单（那正是过去漏维的根因）。
 */
export function activeFilterSignature(ctx: ViewContext): string {
	return activeFilters(ctx)
		.map((f) => `${f.key}=${f.value}`)
		.join("\u0001");
}

/** 统一收尾：胶囊选中态 + chips + 重置按钮高亮，然后重渲染列表 */
function refreshAfterFilterChange(ctx: ViewContext): void {
	// updateFacetVisibility 被包装为「基础逻辑 + syncFilterChips()」，
	// 后者会调用全部 update*Toggle，因此胶囊态无需各维度自行同步。
	ctx.updateFacetVisibility();
	// 保留滚动位置：筛选变更不应把用户从第 N 条弹回顶部
	ctx.scheduleRender(true);
}
