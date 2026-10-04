import { describe, it, expect, vi } from "vitest";
import { Menu } from "obsidian";
import { renderUpdatesList } from "@ui/view/view-updates";
import { makeMockContext } from "@shared/test-utils";
import type { ViewContext } from "@ui/view/view-context";
import type { PluginInfo } from "@domain/catalog/translator";

/**
 * renderUpdatesList 的 DOM 单测。
 *
 * jsdom 下 Obsidian 挂在 HTMLElement 上的 createEl/createDiv/createSpan/setText/hasClass
 * 需要就地补齐（test/setup.ts 只补了 setCssStyles/empty/addClass 等，元素级构造函数未补）。
 */
function patchDomHelpers() {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (this: HTMLElement, tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }) {
			const el = document.createElement(tag);
			if (o?.cls) el.className = o.cls;
			if (o?.text != null) el.textContent = o.text;
			if (o?.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) proto.createDiv = function (this: HTMLElement, o?: unknown) { return (this.createEl as (t: string, o?: unknown) => HTMLElement)("div", o); };
	if (!proto.createSpan) proto.createSpan = function (this: HTMLElement, o?: unknown) { return (this.createEl as (t: string, o?: unknown) => HTMLElement)("span", o); };
	if (!proto.setText) proto.setText = function (this: HTMLElement, t: string) { this.textContent = t; return this; };
	if (!proto.hasClass) proto.hasClass = function (this: HTMLElement, c: string) { return this.classList.contains(c); };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	const container = document.createElement("div");
	const ctx = makeMockContext({
		// 简易 t：回显 key，带参时追加参数值（测试只断言结构，不断言固定文案）
		t: ((k: string, p?: Record<string, string>) =>
			p ? `${k} ${Object.values(p).join(" ")}` : k) as unknown as ViewContext["t"],
		updatesListEl: container,
		outdatedIds: new Set(["a", "b"]),
		outdatedInfo: new Map([
			["a", { local: "1.0.0", latest: "1.1.0" }],
			["b", { local: "2.0.0", latest: "2.1.0" }],
		]),
		allPlugins: [
			{ id: "a", name: "Alpha" },
			{ id: "b", name: "Beta" },
		] as unknown as PluginInfo[],
		updateSelection: new Set(["a", "b"]),
		updatesViewMode: "pending",
		installedIds: new Set(["a", "b"]),
		enabledIds: new Set(["a", "b"]),
		installedVersions: new Map([
			["a", "1.0.0"],
			["b", "2.0.0"],
		]),
		pluginVersionPins: {},
		updatePlugin: vi.fn(async () => {}),
		updateAll: vi.fn(async () => {}),
		updateSelected: vi.fn(async () => {}),
		refreshViewTabsBadge: vi.fn(),
		track: vi.fn(),
		...overrides,
	});
	ctx.renderUpdatesList = () => renderUpdatesList(ctx);
	return { ctx, container };
}

describe("renderUpdatesList 「更新」页签列表", () => {
	it("无更新时渲染空态", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({
			outdatedIds: new Set(),
			outdatedInfo: new Map(),
			allPlugins: [],
		});
		renderUpdatesList(ctx);
		expect(container.querySelector(".pt-updates-empty-title")?.textContent).toBe("updates.empty");
		expect(container.querySelectorAll(".pt-updates-row").length).toBe(0);
	});

	it("按名称排序列出可更新插件并显示版本差", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderUpdatesList(ctx);
		const rows = container.querySelectorAll(".pt-updates-row");
		expect(rows.length).toBe(2);
		expect(rows[0].querySelector(".pt-updates-name")?.textContent).toBe("Alpha");
		expect(rows[1].querySelector(".pt-updates-name")?.textContent).toBe("Beta");
		expect(rows[0].textContent).toContain("1.0.0");
		expect(rows[0].textContent).toContain("1.1.0");
	});

	it("全选 / 取消全选更新勾选集合", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ updateSelection: new Set<string>() });
		renderUpdatesList(ctx);
		(container.querySelector(".pt-updates-selectall") as HTMLElement).dispatchEvent(new MouseEvent("click"));
		expect(ctx.updateSelection.has("a")).toBe(true);
		expect(ctx.updateSelection.has("b")).toBe(true);
		(container.querySelector(".pt-updates-deselect") as HTMLElement).dispatchEvent(new MouseEvent("click"));
		expect(ctx.updateSelection.size).toBe(0);
	});

	it("勾选框同步 updateSelection", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ updateSelection: new Set<string>() });
		renderUpdatesList(ctx);
		const cb = container.querySelector(".pt-updates-check") as HTMLInputElement;
		cb.checked = true;
		cb.dispatchEvent(new Event("change"));
		expect(ctx.updateSelection.has("a")).toBe(true);
		cb.checked = false;
		cb.dispatchEvent(new Event("change"));
		expect(ctx.updateSelection.has("a")).toBe(false);
	});

	it("点「更新所选」只更新已勾选项", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ updateSelection: new Set(["b"]) });
		renderUpdatesList(ctx);
		(container.querySelector(".pt-updates-update-sel") as HTMLElement).dispatchEvent(new MouseEvent("click"));
		expect(ctx.updateSelected).toHaveBeenCalledWith(["b"], expect.any(Function));
		// 进度条层被挂载（批量更新期间显示，结束后由 renderUpdatesList 清空）
		expect(container.querySelector(".pt-updates-progress")).not.toBeNull();
	});

	it("行内更新按钮触发单插件更新", async () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderUpdatesList(ctx);
		(container.querySelectorAll(".pt-updates-row-update")[0] as HTMLElement).dispatchEvent(new MouseEvent("click"));
		await vi.waitFor(() => expect(ctx.updatePlugin).toHaveBeenCalledWith("a"));
	});
});

/**
 * 视图切换：pending（默认，只列可更新）/ installed（全部已安装状态总览）。
 * installed 视图回答「我装了啥、它们各自什么状态」，且同一插件只出现在一个分组里。
 */
describe("renderUpdatesList 视图切换（待更新 / 全部已安装）", () => {
	/** 4 个已安装插件：a 可更新、b 已是最新、c 已停用、d 已固定版本 */
	function makeInventoryCtx() {
		return makeCtx({
			outdatedIds: new Set(["a"]),
			outdatedInfo: new Map([["a", { local: "1.0.0", latest: "1.1.0" }]]),
			allPlugins: [
				{ id: "a", name: "Alpha" },
				{ id: "b", name: "Beta" },
				{ id: "c", name: "Gamma" },
				{ id: "d", name: "Delta" },
			] as unknown as PluginInfo[],
			updateSelection: new Set<string>(),
			updatesViewMode: "installed",
			installedIds: new Set(["a", "b", "c", "d"]),
			enabledIds: new Set(["a", "b", "d"]),
			installedVersions: new Map([
				["a", "1.0.0"],
				["b", "2.0.0"],
				["c", "0.9.0"],
				["d", "3.0.0"],
			]),
			pluginVersionPins: { d: "3.0.0" },
		});
	}

	/** 取每个分组的标题与行内插件名，供断言 */
	function readGroups(container: HTMLElement) {
		return Array.from(container.querySelectorAll(".pt-updates-group")).map((g) => ({
			title: g.querySelector(".pt-updates-group-title")?.textContent ?? "",
			names: Array.from(g.querySelectorAll(".pt-updates-name")).map((n) => n.textContent),
		}));
	}

	it("默认是「待更新」视图：只列可更新插件，已固定的独立成分组", () => {
		patchDomHelpers();
		const { ctx, container } = makeInventoryCtx();
		ctx.updatesViewMode = "pending";
		renderUpdatesList(ctx);
		// 扁平列表区只有可更新的 Alpha（已固定的 Delta 走独立分组，不混进来）
		const flat = Array.from(
			container.querySelectorAll(":scope > .pt-updates-rows > .pt-updates-row .pt-updates-name"),
		).map((n) => n.textContent);
		expect(flat).toEqual(["Alpha"]);
		// 已固定版本在待更新视图下仍可见（这类插件不参与自动更新检测，否则用户无法解除固定）
		expect(container.querySelectorAll(".pt-updates-group").length).toBe(1);
		expect(container.querySelector(".pt-updates-group-title")?.textContent).toBe("updates.pinned.title (1)");
	});

	it("「全部已安装」视图按 可更新 / 已固定 / 已停用 / 已是最新 分组", () => {
		patchDomHelpers();
		const { ctx, container } = makeInventoryCtx();
		renderUpdatesList(ctx);
		const groups = readGroups(container);
		expect(groups.map((g) => g.title)).toEqual([
			"updates.group.outdated (1)",
			"updates.pinned.title (1)",
			"updates.group.disabled (1)",
			"updates.group.latest (1)",
		]);
		expect(groups.map((g) => g.names)).toEqual([["Alpha"], ["Delta"], ["Gamma"], ["Beta"]]);
	});

	it("每个插件只出现在一个分组（优先级：可更新 > 已固定 > 已停用 > 已是最新）", () => {
		patchDomHelpers();
		// d 同时满足「可更新 + 已固定 + 已停用」，应只落到「可更新」组
		const { ctx, container } = makeCtx({
			outdatedIds: new Set(["d"]),
			outdatedInfo: new Map([["d", { local: "1.0.0", latest: "2.0.0" }]]),
			allPlugins: [{ id: "d", name: "Delta" }] as unknown as PluginInfo[],
			updateSelection: new Set<string>(),
			updatesViewMode: "installed",
			installedIds: new Set(["d"]),
			enabledIds: new Set<string>(),
			installedVersions: new Map([["d", "1.0.0"]]),
			pluginVersionPins: { d: "1.0.0" },
		});
		renderUpdatesList(ctx);
		const names = Array.from(container.querySelectorAll(".pt-updates-name")).map((n) => n.textContent);
		expect(names).toEqual(["Delta"]);
		expect(container.querySelectorAll(".pt-updates-group").length).toBe(1);
	});

	it("「已是最新 / 已停用」是纯状态行：有版本号与状态标签、无更新按钮", () => {
		patchDomHelpers();
		const { ctx, container } = makeInventoryCtx();
		renderUpdatesList(ctx);
		const groupBy = (title: string) =>
			Array.from(container.querySelectorAll(".pt-updates-group")).find((g) =>
				g.querySelector(".pt-updates-group-title")?.textContent?.startsWith(title),
			) as HTMLElement;
		const latest = groupBy("updates.group.latest");
		expect(latest.querySelector(".pt-updates-name")?.textContent).toBe("Beta");
		expect(latest.querySelector(".pt-updates-diff")?.textContent).toBe("2.0.0");
		expect(latest.querySelector(".pt-updates-tag")?.textContent).toBe("updates.tag.latest");
		expect(latest.querySelectorAll(".pt-updates-row-update").length).toBe(0);
		const disabled = groupBy("updates.group.disabled");
		expect(disabled.querySelector(".pt-updates-tag")?.textContent).toBe("updates.tag.disabled");
	});

	it("点视图下拉切到「全部已安装」→ 状态字段变更并按分组重渲", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderUpdatesList(ctx);
		const btn = container.querySelector(".pt-updates-bar .pt-select-btn") as HTMLElement;
		expect(btn).not.toBeNull();
		btn.dispatchEvent(new MouseEvent("click"));
		// 菜单项顺序 = [待更新, 全部已安装]；Menu.lastShown 是测试 mock 提供的快照入口
		const shown = (Menu as unknown as { lastShown: { items: { cb?: (() => void) | null }[] } | null }).lastShown;
		shown?.items[1].cb?.();
		expect(ctx.updatesViewMode).toBe("installed");
		expect(container.querySelectorAll(".pt-updates-group").length).toBeGreaterThan(0);
	});

	it("未安装任何社区插件时，「全部已安装」给空态并指向「直链」页签", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({
			updatesViewMode: "installed",
			installedIds: new Set<string>(),
			allPlugins: [{ id: "z", name: "Zeta" }] as unknown as PluginInfo[],
		});
		renderUpdatesList(ctx);
		expect(container.querySelector(".pt-updates-empty-title")?.textContent).toBe("updates.installedNone");
		expect(container.querySelectorAll(".pt-updates-row").length).toBe(0);
	});
});
