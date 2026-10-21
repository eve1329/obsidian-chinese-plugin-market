/**
 * 列表整层重渲染前后的焦点保持。
 *
 * 多个列表页（更新 / 收藏 / CSS 片段 / 直链）在每次操作后都会 `el.empty()` 重建整层，
 * 被聚焦的元素随之被移除，`document.activeElement` 回落 `<body>`：
 * - 键盘用户每次操作都要重新 Tab 一遍整个工具栏才能回到刚才的位置；
 * - 收藏页尤其明显：正在搜索框输入时操作 → 焦点跳出输入框，继续打字会被
 *   Obsidian 当作全局快捷键处理。
 *
 * 用法：在清空容器【之前】captureFocus(container)，在重建【之后】restoreFocus(container, token)。
 */

/** 能稳定标识一个元素的属性（按优先级尝试） */
const ID_ATTRS = ["data-plugin-id", "data-cpm-snippet", "data-base", "data-idx"] as const;

export interface FocusToken {
	tag: string;
	/** input 的 type（如 search / text / checkbox） */
	type?: string;
	idAttr?: string;
	idValue?: string;
	/** data-action（卡片操作按钮） */
	action?: string;
	/** 退化标识：aria-label / title */
	label?: string;
}

/** 记录容器内当前焦点元素的稳定标识；焦点不在容器内时返回 null */
export function captureFocus(container: HTMLElement): FocusToken | null {
	const el = document.activeElement as HTMLElement | null;
	if (!el || typeof el.getAttribute !== "function" || !container.contains(el)) return null;
	const idAttr = ID_ATTRS.find((a) => el.hasAttribute(a));
	return {
		tag: el.tagName.toLowerCase(),
		type: el instanceof HTMLInputElement ? el.type : undefined,
		idAttr,
		idValue: idAttr ? el.getAttribute(idAttr) ?? undefined : undefined,
		action: el.getAttribute("data-action") ?? undefined,
		label: el.getAttribute("aria-label") ?? el.getAttribute("title") ?? undefined,
	};
}

/** 按标识在重建后的容器里找回并聚焦；找不到时退回容器内首个可聚焦元素 */
export function restoreFocus(container: HTMLElement, token: FocusToken | null): void {
	if (!token) return;
	const all = Array.from(container.querySelectorAll<HTMLElement>("*"));

	// 1) 按稳定 id 属性定位（卡片 / 片段行），再按 data-action 定位到行内按钮
	if (token.idAttr && token.idValue) {
		const attr = token.idAttr;
		const scope = all.find((el) => el.getAttribute(attr) === token.idValue);
		if (scope) {
			const inner = token.action
				? Array.from(scope.querySelectorAll<HTMLElement>("[data-action]")).find(
						(x) => x.getAttribute("data-action") === token.action,
					)
				: undefined;
			(inner ?? scope).focus();
			return;
		}
	}

	// 2) 输入框（搜索框）：按 type 匹配，并把光标移到末尾
	if (token.tag === "input" && token.type) {
		const input = Array.from(container.querySelectorAll("input")).find(
			(el) => el.type === token.type,
		);
		if (input) {
			input.focus();
			try {
				input.setSelectionRange(input.value.length, input.value.length);
			} catch {
				// 非文本类 input（checkbox 等）不支持 setSelectionRange，忽略
			}
			return;
		}
	}

	// 3) 按无障碍名称匹配按钮
	if (token.label) {
		const btn = all.find(
			(el) =>
				el.getAttribute("aria-label") === token.label || el.getAttribute("title") === token.label,
		);
		if (btn) {
			btn.focus();
			return;
		}
	}

	// 4) 兜底：焦点原本在容器内（token 非 null），至少要落回容器，
	//    否则会掉到 body 并被宿主的全局快捷键接管。
	container
		.querySelector<HTMLElement>('input, button:not([disabled]), [tabindex]:not([tabindex="-1"])')
		?.focus();
}
