const { test, expect } = require("@playwright/test");

async function loadPluginHarness(page) {
	await page.goto("/test/e2e/harness-plugin.html");
	await page.waitForFunction(() => !!window.__e2ePlugin);
}

test.beforeEach(async ({ page }) => {
	await loadPluginHarness(page);
});

test("onload 注册命令 / 设置页 / 视图，并加载推荐清单", async ({ page }) => {
	const info = await page.evaluate(async () => {
		return await window.__e2ePlugin.startPlugin({});
	});
	// 命令注册（关键路径）
	expect(info.commandIds).toContain("open-translator-view");
	expect(info.commandIds).toContain("scroll-debug-on");
	expect(info.commandIds).toContain("scroll-debug-off");
	expect(info.commandNames.length).toBe(info.commandIds.length);
	info.commandNames.forEach((n) => expect(typeof n).toBe("string") && expect(n.length).toBeGreaterThan(0));
	// 设置页 + 视图注册
	expect(info.settingTabs).toBe(1);
	expect(info.viewTypes).toContain("chinese-plugin-market-view");
	// 推荐清单加载（adapater 读取真实 plugin-recommend.json，或降级到内置清单）
	expect(info.recommendedIdsSize).toBeGreaterThan(0);
	// 默认设置水合（未预置时应取 DEFAULT_SETTINGS 的 useMyMemory）
	expect(info.defaultUseMyMemory).toBe(true);
});

test("设置读写：预置 → onload 水合 → 修改 → flush 落盘", async ({ page }) => {
	const result = await page.evaluate(async () => {
		const preset = { sortBy: "downloads" };
		const info = await window.__e2ePlugin.startPlugin(preset);
		const hydrated = info.defaultSortBy; // 应等于预置的 "downloads"，证明读取生效
		// 修改设置并立即落盘
		window.__e2ePlugin.getInstance().settings.sortBy = "name";
		await window.__e2ePlugin.getInstance().flushSaveSettings();
		const stored = window.__e2ePlugin.getData();
		return { hydrated, storedSortBy: stored.sortBy };
	});
	expect(result.hydrated).toBe("downloads");
	expect(result.storedSortBy).toBe("name");
});

test("命令回调可触发：打开视图命令不抛错", async ({ page }) => {
	const ok = await page.evaluate(async () => {
		await window.__e2ePlugin.startPlugin({});
		const openCmd = window.__e2ePlugin.getInstance().commands.find(
			(c) => c.id === "open-translator-view"
		);
		if (!openCmd || typeof openCmd.callback !== "function") return false;
		try {
			openCmd.callback();
			return true;
		} catch (e) {
			console.error(e);
			return false;
		}
	});
	expect(ok).toBe(true);
});

test("设置页自定义 render 条目可渲染（含搜索诊断区空态）", async ({ page }) => {
	const items = await page.evaluate(async () => {
		await window.__e2ePlugin.startPlugin({});
		return window.__e2ePlugin.renderSettingItems();
	});

	// 这些条目走的是自定义 render 回调（非声明式 control）：鸣谢 / 向量索引 /
	// 自托管源 / 搜索诊断。此前 e2e 只统计 settingTabs 数量，从未执行过它们。
	expect(items.length).toBeGreaterThanOrEqual(4);
	expect(items.map((i) => i.group)).toContain("搜索诊断");

	// 未搜索过 → 应渲染空态提示 + 刷新按钮，而不是抛错或留白
	const diag = items.find((i) => i.group === "搜索诊断");
	expect(diag).toBeTruthy();
	expect(diag.html).toContain("尚未执行过搜索");
	expect(diag.buttons).toContain("刷新");
});

test("搜索诊断区在有计时快照时渲染出分段、计数器与刷新按钮", async ({ page }) => {
	const diag = await page.evaluate(async () => {
		await window.__e2ePlugin.startPlugin({});
		// 注入一份快照，避免 e2e 依赖真实搜索（真实搜索需要 LLM / 本地模型）
		window.__e2ePlugin.getInstance().translator.getLastSearchTiming = () => ({
			phases: [
				{ name: "关键词召回", ms: 0.2 },
				{ name: "LLM 精排", ms: 812.1 },
			],
			totalMs: 812.3,
			counters: { 插件数: 6000, 关键词命中: 41 },
			at: 1700000000000,
		});
		return window.__e2ePlugin
			.renderSettingItems()
			.find((i) => i.group === "搜索诊断");
	});

	expect(diag).toBeTruthy();
	// 总计与本地阶段口径
	expect(diag.html).toContain("总计 812.3 ms");
	expect(diag.html).toContain("本地阶段 0.2 ms");
	// 每个阶段一行，含耗时与占比条（原生 progress）
	expect(diag.html).toContain("关键词召回");
	expect(diag.html).toContain("0.2 ms");
	expect(diag.html).toContain("LLM 精排");
	expect(diag.html).toContain("812.1 ms");
	expect(diag.html).toContain("<progress");
	// 计数器用于判断「慢」还是「配置不对」
	expect(diag.html).toContain("插件数=6000");
	expect(diag.html).toContain("关键词命中=41");
	expect(diag.buttons).toContain("刷新");
});
