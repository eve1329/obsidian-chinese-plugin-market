/**
 * E2E 测试入口（浏览器侧）——整插件启动关键路径。
 * 实例化真实 ChinesePluginMarketPlugin，跑 onload()，暴露 window.__e2ePlugin
 * 供 Playwright 断言「命令注册 / 设置页 / 视图注册 / 设置读写」。
 * 不依赖真实 Obsidian 运行时，仅用 obsidian-mock 提供的 App/数据仓。
 */
import "./obsidian-mock";
import ChinesePluginMarketPlugin from "../../src/app/plugin";
import { makeApp, Setting } from "./obsidian-mock";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import manifest from "../../manifest.json";

let instance: any = null;

interface StartResult {
	commandIds: string[];
	commandNames: string[];
	settingTabs: number;
	viewTypes: string[];
	recommendedIdsSize: number;
	recommendedTitle: string;
	defaultLanguage: string | undefined;
}

async function startPlugin(presetData: Record<string, unknown> = {}): Promise<StartResult> {
	instance = new ChinesePluginMarketPlugin(makeApp(), {
		id: "chinese-plugin-market",
		...(manifest as Record<string, unknown>),
	});
	// 预置数据仓（模拟已落盘的 data.json），供「设置读取」断言
	instance._data = { ...presetData };
	// e2e 环境无真实 metadataCache，模拟「已 resolved」，避免 scanVaultTM 卡在 waitMetadataResolved
	(instance as any).waitMetadataResolved = async () => {};
	await instance.onload();
	// 推荐清单加载已移到 onLayoutReady → initDeferredLoad（异步），onload() 返回时可能未完成；
	// 轮询等待 recommendedIds 填充（读取 plugin-recommend.json 或 fallback 内置清单），最多 6s
	const t0 = Date.now();
	while (instance.recommendedIds.size === 0 && Date.now() - t0 < 6000) {
		await new Promise((r) => setTimeout(r, 25));
	}
	return {
		commandIds: instance.commands.map((c: any) => c.id),
		commandNames: instance.commands.map((c: any) => c.name),
		settingTabs: instance.settingTabs.length,
		viewTypes: instance.views.map((v: any) => v.type),
		recommendedIdsSize: instance.recommendedIds.size,
		recommendedTitle: instance.recommendedTitle,
		defaultUseMyMemory: instance.settings.useMyMemory,
		defaultSortBy: instance.settings.sortBy,
	};
}

/** 单个「自定义 render」设置项的渲染结果 */
interface RenderedSettingItem {
	group: string;
	name: string;
	html: string;
	buttons: string[];
}

/**
 * 渲染设置页里所有「自定义 render」条目，返回其产出。
 *
 * 为什么需要：`getSettingDefinitions()` 中有若干条目走自定义 render 回调而非声明式
 * control（鸣谢 / 向量索引 / 自托管源 / 搜索诊断）。原先 e2e 只统计 settingTabs 数量，
 * 这些回调从未被执行 —— 其中的 Obsidian API 误用只能在用户真实打开设置页时才暴露。
 * 这里把它们全部跑一遍，使「设置页能渲染出来」成为可断言的事实。
 */
function renderSettingItems(): RenderedSettingItem[] {
	const tab = instance?.settingTabs?.[0] as
		| {
				getSettingDefinitions?: () => {
					heading?: string;
					items?: { name?: string; render?: (s: Setting) => void }[];
				}[];
		  }
		| undefined;
	if (!tab || typeof tab.getSettingDefinitions !== "function") return [];

	const out: RenderedSettingItem[] = [];
	for (const group of tab.getSettingDefinitions()) {
		for (const item of group.items ?? []) {
			if (typeof item.render !== "function") continue;
			const host = document.createElement("div");
			const setting = new Setting(host);
			item.render(setting);
			out.push({
				group: group.heading ?? "",
				name: item.name ?? "",
				html: host.innerHTML,
				buttons: setting.buttons.map((b) => b.text),
			});
		}
	}
	return out;
}

(window as any).__e2ePlugin = {
	startPlugin,
	getInstance: () => instance,
	getData: () => (instance ? instance._data : null),
	renderSettingItems,
	reset: () => {
		instance = null;
	},
};
