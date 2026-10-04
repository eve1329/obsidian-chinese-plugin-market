/**
 * 「更新」页签列表渲染器。
 *
 * 主视图顶部的「更新」页签切到本视图时，调用 renderUpdatesList 在
 * ctx.updatesListEl 中渲染。工具条右侧的 ⇕ 下拉在两种视图间切换：
 * - pending（默认）：只列有官方新版可更的插件（「名称 + 版本差 + 勾选框 + 选版本 + 更新」），
 *   保持「待办」语义，点进来 3 秒完成批量更新，不被上百个已装插件稀释；
 * - installed：全部已安装社区插件的状态总览，按 可更新 / 已固定 / 已是最新 / 已停用 分组，
 *   回答「我装了啥、它们各自什么状态」；0 个可更新时不再是一片空白。
 *
 * 直链安装的插件与主题仍由「直链」页签负责，不在此重复（它们也不在社区列表里）。
 * 「已固定版本」在两种模式下都可见：这类插件不参与自动更新检测，若只出现在
 * installed 视图里，pending 视图的用户将无法看到/解除固定。
 */

import { Notice, setIcon } from "obsidian";
import type { ViewContext, UpdatesViewMode } from "@ui/view/view-context";
import { refreshOutdated } from "@ui/view/view-data";
import { openVersionPicker } from "@ui/components/version-picker-modal";
import { createUpdateProgressLayer } from "@ui/components/update-progress";
import { createMenuSelect } from "@ui/components/menu-select";
import type { PluginInfo } from "@domain/catalog/translator";
import type { I18nKey } from "@shared/i18n";

/** 打开某插件的版本选择弹窗（更新页签与详情抽屉共用同一交互） */
function openPickerFor(ctx: ViewContext, id: string, name: string, repo: string): void {
	openVersionPicker({
		app: ctx.app,
		pluginName: name,
		repo,
		pinned: ctx.pluginVersionPins?.[id] ?? null,
		installedVersion: ctx.installedVersions?.get(id),
		listVersions: (r, force) => ctx.listPluginVersions(r, force),
		onPick: (version) => ctx.pinPluginVersion(id, version),
	});
}

/** 勾选变化后就地刷新「已选 N / 共 M」与「更新所选(N)」，避免整页重绘丢失焦点/滚动 */
type SyncSelUI = () => void;

function addPinButton(ctx: ViewContext, row: HTMLElement, p: PluginInfo): void {
	const pinBtn = row.createEl("button", {
		cls: "pt-updates-row-pin clickable-icon",
		attr: { "aria-label": ctx.t("updates.pin"), title: ctx.t("updates.pin"), type: "button" },
	});
	setIcon(pinBtn, "tag");
	pinBtn.addEventListener("click", () => {
		if (p.repo) openPickerFor(ctx, p.id, p.name, p.repo);
	});
}

function addUpdateButton(ctx: ViewContext, row: HTMLElement, p: PluginInfo): void {
	const updBtn = row.createEl("button", {
		cls: "pt-updates-row-update clickable-icon",
		attr: { "aria-label": ctx.t("action.update"), title: ctx.t("action.update"), type: "button" },
	});
	setIcon(updBtn, "arrow-down-to-line");
	updBtn.addEventListener("click", () => {
		void (async () => {
			if (updBtn.hasClass("pt-spin")) return;
			updBtn.addClass("pt-spin");
			await ctx.updatePlugin(p.id);
			updBtn.removeClass("pt-spin");
			ctx.refreshViewTabsBadge?.();
			ctx.renderUpdatesList();
		})();
	});
}

/** 可更新行：勾选框 + 名称 + 版本差 + 选版本 + 更新 */
function renderOutdatedRow(
	ctx: ViewContext,
	row: HTMLElement,
	p: PluginInfo,
	syncSelUI: SyncSelUI,
): void {
	const info = ctx.outdatedInfo?.get(p.id);
	const cb = row.createEl("input", {
		cls: "pt-updates-check",
		type: "checkbox",
		attr: { type: "checkbox", "aria-label": p.name },
	});
	cb.checked = ctx.updateSelection.has(p.id);
	cb.addEventListener("change", () => {
		if (cb.checked) ctx.updateSelection.add(p.id);
		else ctx.updateSelection.delete(p.id);
		syncSelUI();
	});
	row.createDiv({ cls: "pt-updates-name", text: p.name });
	row.createDiv({
		cls: "pt-updates-diff",
		text: ctx.t("updates.versionDiff", { local: info?.local ?? "", latest: info?.latest ?? "" }),
	});
	addPinButton(ctx, row, p);
	addUpdateButton(ctx, row, p);
}

/** 已固定版本行：名称 + 固定版本 + 选版本 + 改回「保持最新」 */
function renderPinnedRow(ctx: ViewContext, row: HTMLElement, p: PluginInfo): void {
	row.addClass("pt-updates-row--pinned");
	row.createDiv({ cls: "pt-updates-name", text: p.name });
	row.createDiv({
		cls: "pt-updates-diff pt-updates-pinned-ver",
		text: ctx.t("version.pinned", { version: ctx.pluginVersionPins?.[p.id] ?? "" }),
	});
	addPinButton(ctx, row, p);

	const unpinBtn = row.createEl("button", {
		cls: "pt-updates-row-update pt-updates-unpin clickable-icon",
		attr: { "aria-label": ctx.t("version.latest"), title: ctx.t("version.latest"), type: "button" },
	});
	setIcon(unpinBtn, "arrow-down-to-line");
	unpinBtn.addEventListener("click", () => {
		void (async () => {
			if (unpinBtn.hasClass("pt-spin")) return;
			unpinBtn.addClass("pt-spin");
			await ctx.pinPluginVersion(p.id, null);
			unpinBtn.removeClass("pt-spin");
			ctx.renderUpdatesList();
		})();
	});
}

/** 已是最新 / 已停用行：纯状态展示（无操作按钮），名称 + 本地版本 + 状态标签 */
function renderStatusRow(ctx: ViewContext, row: HTMLElement, p: PluginInfo, tagKey: I18nKey): void {
	row.addClass("pt-updates-row--plain");
	row.createDiv({ cls: "pt-updates-name", text: p.name });
	row.createDiv({ cls: "pt-updates-diff", text: ctx.installedVersions?.get(p.id) ?? "" });
	row.createDiv({ cls: "pt-updates-tag", text: ctx.t(tagKey) });
}

/** 状态分组：标题带数量，可选提示，下面挂行 */
function renderGroup(
	parent: HTMLElement,
	title: string,
	plugins: PluginInfo[],
	renderRow: (row: HTMLElement, p: PluginInfo) => void,
	hint?: string,
): void {
	if (plugins.length === 0) return;
	const section = parent.createDiv({ cls: "pt-updates-group" });
	section.createDiv({ cls: "pt-updates-group-title", text: `${title} (${plugins.length})` });
	if (hint) section.createDiv({ cls: "pt-updates-group-hint", text: hint });
	const rows = section.createDiv({ cls: "pt-updates-rows" });
	for (const p of plugins) renderRow(rows.createDiv({ cls: "pt-updates-row" }), p);
}

export function renderUpdatesList(ctx: ViewContext): void {
	const el = ctx.updatesListEl;
	if (!el) return;
	const t = ctx.t;
	el.empty();

	const outdated = [...(ctx.outdatedIds ?? [])];
	const installedMode = (ctx.updatesViewMode ?? "pending") === "installed";

	// ── 顶部工具条 ──
	const bar = el.createDiv({ cls: "pt-updates-bar" });
	const count = bar.createSpan({
		cls: "pt-updates-count",
		text: t("updates.count", { n: String(ctx.updateSelection.size), m: String(outdated.length) }),
	});

	const checkBtn = bar.createEl("button", {
		cls: "pt-updates-checkbtn clickable-icon",
		attr: { "aria-label": t("action.checkUpdate"), title: t("action.checkUpdate"), type: "button" },
	});
	setIcon(checkBtn, "download-cloud");
	checkBtn.addEventListener("click", () => {
		checkBtn.addClass("pt-spin");
		void refreshOutdated(ctx)
			.then(() => {
				ctx.refreshViewTabsBadge?.();
				const n = ctx.outdatedIds?.size ?? 0;
				if (n <= 0) new Notice(t("action.checkUpdate.upToDate"));
				else new Notice(t("action.checkUpdate.available", { n: String(n) }));
			})
			.catch(() => new Notice(t("action.checkUpdate.failed")))
			.finally(() => {
				checkBtn.removeClass("pt-spin");
				ctx.renderUpdatesList();
			});
	});

	const selectAll = bar.createEl("button", { cls: "pt-updates-selectall", text: t("updates.selectAll") });
	selectAll.addEventListener("click", () => {
		outdated.forEach((id) => ctx.updateSelection.add(id));
		ctx.renderUpdatesList();
	});
	const deselectAll = bar.createEl("button", { cls: "pt-updates-deselect", text: t("updates.deselectAll") });
	deselectAll.addEventListener("click", () => {
		ctx.updateSelection.clear();
		ctx.renderUpdatesList();
	});

	const updateSel = bar.createEl("button", {
		cls: "pt-updates-update-sel",
		text: t("updates.updateSelected", { n: String(ctx.updateSelection.size) }),
	});
	updateSel.addEventListener("click", () => {
		const ids = [...ctx.updateSelection];
		if (ids.length === 0) return;
		runBatchUpdate(ctx, bar, ids, false);
	});

	const updateAll = bar.createEl("button", { cls: "pt-updates-update-all", text: t("updates.updateAll") });
	updateAll.addEventListener("click", () => {
		const ids = [...(ctx.outdatedIds ?? [])];
		if (ids.length === 0) {
			new Notice(t("action.update.none"));
			return;
		}
		runBatchUpdate(ctx, bar, ids, true);
	});

	// 视图切换（.pt-select 配方 + ⇕ 图标，与浏览页筛选下拉同语言）：
	// pending = 只看待更新；installed = 全部已安装插件状态总览
	createMenuSelect(bar, {
		getOptions: () => [
			{ value: "pending", label: t("updates.view.pending") },
			{ value: "installed", label: t("updates.view.installed") },
		],
		getValue: () => ctx.updatesViewMode ?? "pending",
		onPick: (v) => {
			if (v === (ctx.updatesViewMode ?? "pending")) return;
			ctx.updatesViewMode = v as UpdatesViewMode;
			ctx.renderUpdatesList();
		},
	});

	const syncSelUI: SyncSelUI = () => {
		count.setText(t("updates.count", { n: String(ctx.updateSelection.size), m: String(outdated.length) }));
		updateSel.setText(t("updates.updateSelected", { n: String(ctx.updateSelection.size) }));
	};

	// ── 全部已安装：按状态分组总览 ──
	if (installedMode) {
		renderInstalledGroups(ctx, el, syncSelUI);
		return;
	}

	// ── 空态 ──
	if (outdated.length === 0) {
		const empty = el.createDiv({ cls: "pt-updates-empty" });
		empty.createDiv({ cls: "pt-updates-empty-title", text: t("updates.empty") });
		empty.createDiv({ cls: "pt-updates-empty-hint", text: t("updates.empty.hint") });
		renderGroup(el, t("updates.pinned.title"), pinnedPlugins(ctx), (row, p) => renderPinnedRow(ctx, row, p), t("updates.pinned.hint"));
		return;
	}

	// ── 行列表（按名称排序，便于定位）──
	const rows = el.createDiv({ cls: "pt-updates-rows" });
	const infos = ctx.allPlugins
		.filter((p) => ctx.outdatedIds?.has(p.id))
		.sort((a, b) => a.name.localeCompare(b.name));

	for (const p of infos) {
		renderOutdatedRow(ctx, rows.createDiv({ cls: "pt-updates-row" }), p, syncSelUI);
	}

	renderGroup(el, t("updates.pinned.title"), pinnedPlugins(ctx), (row, p) => renderPinnedRow(ctx, row, p), t("updates.pinned.hint"));
}

/** 已固定版本的已安装插件（按名称排序） */
function pinnedPlugins(ctx: ViewContext): PluginInfo[] {
	const pins = ctx.pluginVersionPins ?? {};
	return ctx.allPlugins
		.filter((p) => pins[p.id] && (ctx.installedIds?.has(p.id) ?? false))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 「全部已安装」视图：已安装插件按状态分组（可更新 / 已固定 / 已是最新 / 已停用）。
 *
 * 分组按优先级独占分配——每个插件只出现在一个分组里（可更新 > 已固定 > 已停用 > 已是最新），
 * 避免同一个插件在两处重复出现。可更新置顶，保证待办仍然第一眼可见。
 */
function renderInstalledGroups(ctx: ViewContext, el: HTMLElement, syncSelUI: SyncSelUI): void {
	const t = ctx.t;
	const installed = ctx.allPlugins.filter((p) => ctx.installedIds?.has(p.id) ?? false);

	if (installed.length === 0) {
		const empty = el.createDiv({ cls: "pt-updates-empty" });
		empty.createDiv({ cls: "pt-updates-empty-title", text: t("updates.installedNone") });
		empty.createDiv({ cls: "pt-updates-empty-hint", text: t("updates.installedNone.hint") });
		return;
	}

	const byName = (a: PluginInfo, b: PluginInfo) => a.name.localeCompare(b.name);
	const taken = new Set<string>();
	const take = (pred: (p: PluginInfo) => boolean): PluginInfo[] => {
		const list = installed.filter((p) => !taken.has(p.id) && pred(p)).sort(byName);
		for (const p of list) taken.add(p.id);
		return list;
	};

	renderGroup(
		el,
		t("updates.group.outdated"),
		take((p) => ctx.outdatedIds?.has(p.id) ?? false),
		(row, p) => renderOutdatedRow(ctx, row, p, syncSelUI),
	);
	renderGroup(
		el,
		t("updates.pinned.title"),
		take((p) => Boolean(ctx.pluginVersionPins?.[p.id])),
		(row, p) => renderPinnedRow(ctx, row, p),
		t("updates.pinned.hint"),
	);
	renderGroup(
		el,
		t("updates.group.disabled"),
		take((p) => !(ctx.enabledIds?.has(p.id) ?? true)),
		(row, p) => renderStatusRow(ctx, row, p, "updates.tag.disabled"),
	);
	renderGroup(
		el,
		t("updates.group.latest"),
		take(() => true),
		(row, p) => renderStatusRow(ctx, row, p, "updates.tag.latest"),
	);
}

/**
 * 批量更新并展示进度条：进度条挂在列表容器内、工具条之后；批量期间 updateAll/updateSelected
 * 跳过逐条列表重渲（skipListRender），由它们在末尾统一刷新，进度条随之自然消失。
 */
function runBatchUpdate(
	ctx: ViewContext,
	bar: HTMLElement,
	ids: string[],
	all: boolean,
): void {
	const prog = createUpdateProgressLayer();
	bar.after(prog.el);
	ctx.track(all ? "action:updateAll" : "action:updateSelected");
	const onProgress = (done: number, total: number, label?: string) =>
		prog.set(done, total, label ? ctx.t("action.update.current", { name: label }) : undefined);
	const task = all ? ctx.updateAll(onProgress) : ctx.updateSelected(ids, onProgress);
	void task.finally(() => prog.finish());
}
