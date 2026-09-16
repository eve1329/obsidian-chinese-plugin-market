import { describe, it, expect } from "vitest";
import { Platform } from "obsidian";
import { TranslatorSettingTab } from "@app/settings-tab";

function findEmbeddingModeDefinition(items: any[]): any {
	for (const item of items) {
		if (item?.control?.key === "embeddingSource") return item;
		if (Array.isArray(item?.items)) {
			const found = findEmbeddingModeDefinition(item.items);
			if (found) return found;
		}
	}
	return null;
}

function makeTab() {
	const plugin = {
		settings: {},
		translator: { getAIDictSize: () => 0 },
		flushSaveSettings: async () => {},
	} as any;
	return { tab: new TranslatorSettingTab({} as any, plugin), plugin };
}

describe("设置页 · 移动端本地语义开关", () => {
	it("移动端隐藏 local 选项，并把外部 local 写入归一为 keyword", async () => {
		const previous = Platform.isMobile;
		Platform.isMobile = true;
		try {
			const { tab, plugin } = makeTab();
			const mode = findEmbeddingModeDefinition(tab.getSettingDefinitions());
			expect(mode?.control?.options).toEqual({
				keyword: "关键词（本地，默认）",
				api: "API 向量（语义）",
			});

			await tab.setControlValue("embeddingSource", "local");
			expect(plugin.settings.embeddingSource).toBe("keyword");
		} finally {
			Platform.isMobile = previous;
		}
	});

	it("桌面端仍保留 local 选项", () => {
		const previous = Platform.isMobile;
		Platform.isMobile = false;
		try {
			const { tab } = makeTab();
			const mode = findEmbeddingModeDefinition(tab.getSettingDefinitions());
			expect(mode?.control?.options?.local).toBe("本地模型（离线语义）");
		} finally {
			Platform.isMobile = previous;
		}
	});
});
