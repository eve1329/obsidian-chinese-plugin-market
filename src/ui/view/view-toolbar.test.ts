import { describe, it, expect, vi, afterEach } from "vitest";
import { buildToolbar } from "@ui/view/view-toolbar";
import { makeMockContext } from "@shared/test-utils";

// jsdom 无 Obsidian 元素助手原型方法：守卫式补齐（不覆盖 test/setup.ts 已有补丁）
const proto = HTMLElement.prototype as any;
function applyInfo(el: HTMLElement, o?: any): HTMLElement {
	if (!o) return el;
	const info = typeof o === "string" ? { cls: o } : o;
	if (info.cls) for (const c of String(info.cls).split(/\s+/)) if (c) el.classList.add(c);
	if (info.text != null) el.textContent = String(info.text);
	if (info.attr) for (const [k, v] of Object.entries(info.attr)) el.setAttribute(k, String(v));
	if (info.type) el.setAttribute("type", String(info.type));
	if (info.placeholder) el.setAttribute("placeholder", String(info.placeholder));
	if (info.value != null) (el as HTMLInputElement).value = String(info.value);
	return el;
}
if (!proto.createDiv) {
	proto.createDiv = function (o?: any) { return applyInfo(this.appendChild(document.createElement("div")), o); };
	proto.createSpan = function (o?: any) { return applyInfo(this.appendChild(document.createElement("span")), o); };
	proto.createEl = function (tag: string, o?: any) { return applyInfo(this.appendChild(document.createElement(tag)), o); };
	proto.setText = function (t: string) { this.textContent = t; return this; };
	proto.setCssStyles = function (s: Record<string, string>) { Object.assign(this.style, s); return this; };
	proto.addClass = function (...cs: string[]) { cs.forEach((c: string) => this.classList.add(c)); return this; };
	proto.removeClass = function (...cs: string[]) { cs.forEach((c: string) => this.classList.remove(c)); return this; };
	proto.toggleClass = function (c: string, v: boolean) { this.classList.toggle(c, v); return this; };
	proto.hasClass = function (c: string) { return this.classList.contains(c); };
	proto.empty = function () { this.textContent = ""; return this; };
	proto.detach = function () { this.parentNode?.removeChild(this); return this; };
}

/**
 * IME composition 守卫回归（2026-09-20 审计 D1-D3 修复配套）：
 * 对照 forum.obsidian.md/t/105167（Obsidian 1.9.12 tracked 回归）同款模式——
 * composition 期间 Enter/Esc/input 不得被搜索动作抢占。
 */
function mk(searchMode = "local") {
	const contentEl = document.createElement("div");
	const fn = () => vi.fn();
	const ctx = makeMockContext({
		contentEl,
		searchQuery: "",
		searchMode,
		settings: {
			aiSearchEnabled: true,
			aiSearchApiKey: "k",
			aiSearchBaseURL: "u",
			aiSearchModel: "m",
			embeddingSource: "keyword",
			aiSearchShowReason: false,
		},
		// 字段默认值（buildToolbar 构建期/事件期可能读）
		aiProgressEl: null, aiSearchQueryCache: "", aiSearchResult: null,
		aiTranslateAllPending: false, aiTranslateBtnEl: null, aiTranslateRunning: false,
		authorFacetEl: null, authorFilter: null, authorRowEl: null, catRowEl: null,
		chineseEcoFilter: null, dataLoaded: true, debounceTimer: undefined, enabledIds: [],
		facetContainerEl: null, favoriteFilter: null, filterCache: {}, installFilter: null,
		journalEntryIds: [], lastAiSearchQuery: "", lastAiSearchResult: null, listState: {},
		manifest: {}, newWithinDays: 0, outdatedIds: [], plugin: {}, plugins: [],
		profiles: [], refreshBtn: null, resultCountEl: null, selectedCategories: [],
		seriesFilter: null, sortBy: "downloads", sortFavoritesFirst: false, sourceFilter: null,
		translator: {}, updatedWithinDays: 0, verdictFilter: null, app: {},
		// 方法全 mock
		t: (k: string) => String(k),
		announceStatus: fn(), applyProfile: fn(), applySearchInput: fn(), ensureDataLoaded: vi.fn().mockResolvedValue(true),
		fillVisibleWindow: fn(), measureLayout: fn(), pluginSaveProfile: fn(), refreshData: fn(),
		refreshFacets: fn(), register: fn(), renderAuthorFacet: fn(), runAISearch: fn(),
		saveSettings: fn(), scheduleRender: fn(), track: fn(), updateAiTranslateButton: fn(),
		updateAll: fn(), updateFacetVisibility: fn(), updateGuidance: fn(), updateRefreshTooltip: fn(),
	} as any);
	const { searchInput } = buildToolbar(ctx as any, { suppressResizeMeasure: true, advancedAnimTimer: 0 });
	return { ctx, searchInput };
}
const key = (k: string, isComposing: boolean) =>
	new KeyboardEvent("keydown", { key: k, cancelable: true, bubbles: true, isComposing });
const comp = (type: string) => new Event(type, { bubbles: true });

afterEach(() => {
	vi.useRealTimers();
});

describe("搜索框 IME composition 守卫（审计 D1-D3）", () => {
	it("组合态 Enter 不触发检索、不 preventDefault；非组合态 Enter 正常触发", () => {
		const { ctx, searchInput } = mk("local");
		searchInput.dispatchEvent(comp("compositionstart"));
		const eComp = key("Enter", true);
		searchInput.dispatchEvent(eComp);
		expect(eComp.defaultPrevented).toBe(false); // 不干扰 IME 确认候选
		expect(ctx.runAISearch).not.toHaveBeenCalled();
		expect(ctx.scheduleRender).not.toHaveBeenCalled();

		searchInput.dispatchEvent(comp("compositionend"));
		const eReal = key("Enter", false);
		searchInput.dispatchEvent(eReal);
		expect(ctx.runAISearch).toHaveBeenCalledTimes(1);
	});

	it("组合态 Escape 不清空搜索框；非组合态 Escape 清空", () => {
		const { ctx, searchInput } = mk();
		searchInput.value = "日历";
		ctx.searchQuery = "日历";
		searchInput.dispatchEvent(comp("compositionstart"));
		searchInput.dispatchEvent(key("Escape", true));
		expect(searchInput.value).toBe("日历"); // 取消候选不应丢已提交汉字
		expect(ctx.searchQuery).toBe("日历");

		searchInput.dispatchEvent(comp("compositionend"));
		searchInput.dispatchEvent(key("Escape", false));
		expect(searchInput.value).toBe("");
	});

	it("composition 期间 input（含空值快速通道）不变更 searchQuery/不渲染", () => {
		const { ctx, searchInput } = mk();
		ctx.searchQuery = "old";
		searchInput.dispatchEvent(comp("compositionstart"));
		searchInput.value = ""; // 组合中途瞬空（删光拼音）
		searchInput.dispatchEvent(new Event("input", { bubbles: true }));
		expect(ctx.searchQuery).toBe("old"); // 空值快速通道被 composing 门挡住
		expect(ctx.scheduleRender).not.toHaveBeenCalled();
	});

	it("compositionend 以最终值触发一次 applySearchInput，且悬挂防抖计时器不再重复触发", () => {
		vi.useFakeTimers();
		const { ctx, searchInput } = mk();
		searchInput.dispatchEvent(comp("compositionstart"));
		searchInput.value = "日历";
		searchInput.dispatchEvent(new Event("input", { bubbles: true })); // 挂上防抖计时器
		searchInput.dispatchEvent(comp("compositionend"));
		expect(ctx.applySearchInput).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(500); // 防抖窗口过后不应二次触发（计时器已被 end 清掉）
		expect(ctx.applySearchInput).toHaveBeenCalledTimes(1);
	});
});
