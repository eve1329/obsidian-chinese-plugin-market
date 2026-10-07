/**
 * 关闭详情抽屉后的「一次性 click 吞噬」回归测试。
 *
 * 背景：为修「双击 × 第二击落在卡片上立即重开详情」，close() 曾在 document
 * 捕获阶段**无条件**吞掉全局下一个 click——导致关闭抽屉后的第一次任意交互
 * （最典型：点搜索框 × 清除按钮）被无声吞掉，用户感知就是「点击没反应」，
 * 第二次点击才生效。真实用户反馈即此。
 * 现约束为只吞「会立即重开详情」的点击：落在 .pt-card 非交互区（与 view-cards
 * 的整卡点击委托同一判定）；工具条 / 搜索清除 / 卡片内按钮等一律放行。
 */
import { describe, it, expect } from "vitest";
import { PluginDetailDrawer } from "@ui/components/detail-drawer";

/** 最小可 close() 的抽屉：close() 对未 open 的实例各字段均有空值保护 */
function makeDrawer(): PluginDetailDrawer {
	return new PluginDetailDrawer({
		app: {},
		plugin: { settings: { favorites: [] } },
		info: { id: "demo" },
		result: {},
		similar: [],
		triggerCard: document.createElement("div"),
	} as unknown as ConstructorParameters<typeof PluginDetailDrawer>[0]);
}

/** 在 target 上派发冒泡 click，返回「target 自己的监听是否收到事件」：
 *  若捕获阶段被 stopPropagation，target 阶段的监听不会触发。 */
function clickReaches(target: HTMLElement): boolean {
	let reached = false;
	target.addEventListener("click", () => (reached = true), { once: true });
	target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	return reached;
}

describe("DetailDrawer.close 后的一次性 click 吞噬", () => {
	it("落在卡片非交互区的点击仍被吞（防关闭后立即重开，原修复保留）", () => {
		makeDrawer().close();
		const card = document.createElement("div");
		card.className = "pt-card";
		card.setAttribute("data-plugin-id", "demo");
		document.body.appendChild(card);
		expect(clickReaches(card)).toBe(false);
		card.remove();
	});

	it("搜索清除按钮等工具条点击放行（回归：曾被吞导致「点击没反应」）", () => {
		makeDrawer().close();
		const clear = document.createElement("button");
		clear.className = "pt-search-clear";
		document.body.appendChild(clear);
		expect(clickReaches(clear)).toBe(true);
		clear.remove();
	});

	it("卡片内的交互控件（收藏 / 更新按钮等）放行", () => {
		makeDrawer().close();
		const card = document.createElement("div");
		card.className = "pt-card";
		const fav = document.createElement("button");
		card.appendChild(fav);
		document.body.appendChild(card);
		expect(clickReaches(fav)).toBe(true);
		card.remove();
	});

	it("吞噬器是一次性的：吞掉一次后，后续点击恢复正常", () => {
		makeDrawer().close();
		const card = document.createElement("div");
		card.className = "pt-card";
		document.body.appendChild(card);
		expect(clickReaches(card)).toBe(false);
		expect(clickReaches(card)).toBe(true);
		card.remove();
	});
});
