/**
 * CSS 片段的平台操作层（I2：封装 app.customCss 与 vault adapter）。
 *
 * 与插件管理对称，但数据源是 `.obsidian/snippets/*.css` 文件 + app.customCss
 * 的启用集合。所有写操作（重命名 / 删除 / 创建）走 vault.adapter 并全程容错，
 * 失败只 warn，绝不抛给原生事件链。
 */

import type { App } from "obsidian";
import { asAppInternals } from "./obsidian-internals";
import { logger } from "@shared/logger";

/** snippets 目录跟随用户自定义的配置目录（通过 Vault#configDir 获取，切勿写死 .obsidian） */

/**
 * snippets 目录（vault 相对路径），跟随用户自定义的配置目录。
 *
 * 不能写死 `.obsidian`：用户可用自定义 configDir，写死会导致整份名单为空。
 */
export function snippetDir(app: App): string {
	const cfg = app.vault?.configDir ?? "";
	return `${cfg.replace(/\/+$/, "")}/snippets`;
}

/**
 * 读取当前已启用 CSS 片段集合。
 *
 * 优先使用运行时 `customCss.enabledSnippets`。独立设置窗口刚打开时，这个集合
 * 可能来自另一个 JS realm，或者暂时为空；首次读取遇到这种启动窗口时，使用
 * `appearance.json` 补齐持久化状态。后续读取仍以运行时集合为准，避免关闭最后
 * 一个片段后被旧的 appearance.json 内容重新打开。`customCss.snippets` 是「检测到
 * 的全部」而非「已启用」，不能拿来推断开关。
 */
function copyEnabledSnippets(value: unknown): Set<string> | null {
	if (!value || typeof value !== "object") return null;
	const result = new Set<string>();
	const candidate = value as { forEach?: unknown };
	if (typeof candidate.forEach === "function") {
		// 原生 Set 的 forEach 依赖接收者；显式保留另一个 realm 的原对象。
		candidate.forEach.call(value, (name: unknown) => {
			if (typeof name === "string") result.add(name.replace(/\.css$/i, ""));
		});
		return result;
	}
	return null;
}

async function readPersistedEnabledSnippets(app: App): Promise<Set<string> | null> {
	const cfgDir = app.vault.configDir;
	try {
		const text = await app.vault.adapter.read(`${cfgDir}/appearance.json`);
		const data = JSON.parse(text) as { enabledCssSnippets?: string[] };
		const arr = Array.isArray(data?.enabledCssSnippets) ? data.enabledCssSnippets : [];
		return new Set(arr.map((n) => n.replace(/\.css$/i, "")));
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 读取 appearance.json 失败，CSS 启用状态将使用运行时集合:", error);
		return null;
	}
}

/**
 * 读取真实启用集合。enabledSnippets 可能来自设置独立窗口的另一个 JS realm，
 * 因此不能用 `instanceof Set`。启动阶段运行时集合还可能暂时为空，而
 * appearance.json 已有上一份持久化状态；此时以持久化集合补齐，避免首次打开全关。
 */
async function readEnabledSnippets(app: App): Promise<Set<string>> {
	const cc = asAppInternals(app).customCss;
	const runtime = copyEnabledSnippets(cc?.enabledSnippets);
	// 惰性读取持久化配置：只有「完全没有运行时集合」或「首次读取且运行时为空」才需要。
	// readEnabledSnippets 会被 waitForSnippetState 的轮询反复调用（单次切换最多十几次），
	// 每次都读一遍 appearance.json 纯属浪费；语义与无条件读取完全一致。
	if (!runtime) return (await readPersistedEnabledSnippets(app)) ?? new Set();
	const firstRead = !enabledStateInitialized.get(app);
	enabledStateInitialized.set(app, true);
	if (firstRead && runtime.size === 0) {
		const persisted = await readPersistedEnabledSnippets(app);
		if ((persisted?.size ?? 0) > 0) return persisted!;
	}
	return runtime;
}

export interface SnippetInfo {
	/** 文件名（含 .css 后缀） */
	name: string;
	/** 去 .css 后缀的基名，用作分组 / 元数据 key */
	baseName: string;
	/** 是否处于启用状态（由 app.customCss.enabledSnippets 或 appearance.json 判定） */
	enabled: boolean;
	/** vault 相对路径 */
	path: string;
}

/**
 * 片段清单缓存（按 app 隔离，避免插件重载 / 多 vault 串味）。
 *
 * 为什么必须缓存：枚举 snippets 只能异步走 `vault.adapter.list`，而 UI 渲染是同步的；
 * 由调用方在合适的时机调 refreshSnippets 预扫，listSnippets 同步读镜像。
 */
const snippetCache = new WeakMap<App, SnippetInfo[]>();
const refreshGeneration = new WeakMap<App, number>();
const enabledStateInitialized = new WeakMap<App, boolean>();

/**
 * 同步读取片段清单镜像（UI 渲染用）。
 *
 * 尚未异步扫描过（或扫描失败）时返回空数组——此时为空是「还没加载」，
 * 而不是「vault 里没有片段」，UI 层据此区分加载态与真空态。
 */
export function listSnippets(app: App): SnippetInfo[] {
	return snippetCache.get(app) ?? [];
}

/**
 * 异步重扫 snippets 目录并刷新缓存（多入口共用：启动 / 进入外观页 / 打开设置页 / 重命名后）。
 *
 * 为什么不能用 `app.vault.getFiles()`：配置目录（默认 .obsidian，可被用户改名）
 * **根本不在 vault 文件树里** —— 它既不广播 create/delete 事件，也不会出现在
 * getFiles() 的结果中。此前用它枚举片段，结果恒为空，于是出现「原生外观页显示
 * 已启用 N 个片段、本插件显示 0 个并提示暂无片段」的错位。
 * Obsidian 自身加载片段同样是 `adapter.list(<configDir>/snippets)`。
 */
export async function refreshSnippets(app: App): Promise<SnippetInfo[]> {
	const generation = (refreshGeneration.get(app) ?? 0) + 1;
	refreshGeneration.set(app, generation);
	const dir = snippetDir(app);
	const enabled = await readEnabledSnippets(app);
	const byBase = new Map<string, string>();

	const { files, fallback } = await listSnippetFileNames(app, dir);
	for (const fileName of files) {
		byBase.set(fileName.replace(/\.css$/i, ""), fileName);
	}
	// 兜底：adapter.list 失败（fallback）或目录确实为空时，才把 customCss 里处于启用
	// 状态的片段呈现出来，避免「原生有、本插件 0 个」的错位。adapter.list 成功且读到
	// 文件时只显示真实文件，防止 appearance.json 里残留的历史启用项被当成幽灵片段。
	if (fallback || byBase.size === 0) {
		for (const baseName of enabled) {
			if (!byBase.has(baseName)) byBase.set(baseName, `${baseName}.css`);
		}
	}

	const list = Array.from(byBase, ([baseName, fileName]) => ({
		name: fileName,
		baseName,
		enabled: enabled.has(baseName),
		path: `${dir}/${fileName}`,
	})).sort((a, b) => a.baseName.localeCompare(b.baseName));

	// 旧的 adapter.list / appearance.json 读取完成后，不能覆盖较新的扫描结果。
	if (refreshGeneration.get(app) === generation) snippetCache.set(app, list);
	return list;
}

interface SnippetFileNames {
	files: string[];
	/** 为 true 表示 adapter.list 抛错（目录读取失败），由上层退回 customCss 启用清单 */
	fallback: boolean;
}

/**
 * 读取 snippets 目录下的 .css 文件名。
 *
 * 只枚举目标目录（adapter.list(dir)），不调用 vault.getFiles / getMarkdownFiles 等枚举
 * 全 vault 的 API —— 后者既会暴露 vault 内所有文件路径（Vault Enumeration 安全告警），
 * 在本场景下又是死代码：CSS 片段位于 <configDir>/snippets（默认 .obsidian/snippets），
 * 该目录本就【不在】vault 文件树中，getFiles() 的结果里永远不会有它，fallback 恒返回空。
 *
 * adapter.list 失败时无法得知真实文件，返回空 + fallback:true，由 refreshSnippets 退回到
 * customCss 的启用清单，避免「本插件显示 0 个片段」的错位。
 */
async function listSnippetFileNames(app: App, dir: string): Promise<SnippetFileNames> {
	try {
		const listing = await app.vault.adapter.list(dir);
		const files = (listing?.files ?? [])
			.map((p) => p.split("/").pop() ?? "")
			.filter((name) => name.toLowerCase().endsWith(".css"));
		return { files, fallback: false };
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 扫描 CSS 片段目录失败，退回 customCss 启用清单:", error);
		return { files: [], fallback: true };
	}
}

/** 某个片段是否启用（优先运行时集合；没有运行时集合时以最近一次扫描缓存为准） */
export function isSnippetEnabled(app: App, baseName: string): boolean {
	const cc = asAppInternals(app).customCss;
	const runtime = copyEnabledSnippets(cc?.enabledSnippets);
	if (runtime) return runtime.has(baseName);
	// 无运行时集合时，以最近一次 refreshSnippets 缓存为准
	const cached = snippetCache.get(app)?.find((s) => s.baseName === baseName);
	return cached?.enabled ?? false;
}

/**
 * Obsidian 的 setCssEnabledStatus 会触发异步配置保存 / CSS 重载。等待一次扫描
 * 确认目标值，避免 UI 在旧快照上显示成功；目标文件不存在时立即失败，避免
 * 对明显无效的切换无意义地等待。
 *
 * 预算说明：setCssEnabledStatus 之后是一次完整的 loadSnippets（重新解析并应用全部
 * CSS），片段多 / 机器慢时可达数百毫秒。预算过紧会把「其实已成功但尚未生效」误判成
 * 失败，从而回滚开关并弹出「切换失败」——比不确认更打扰用户。取 20 × 50ms ≈ 1s
 * 作为上限，兼顾准确性与可接受的最长等待。
 */
async function waitForSnippetState(
	app: App,
	baseName: string,
	enabled: boolean,
): Promise<boolean> {
	const attempts = 20;
	const intervalMs = 50;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const list = await refreshSnippets(app);
		const target = list.find((snippet) => snippet.baseName === baseName);
		if (!target) return false;
		if (target.enabled === enabled) return true;
		if (attempt < attempts - 1) {
			await new Promise<void>((resolve) => window.setTimeout(resolve, intervalMs));
		}
	}
	return false;
}

/** 切换片段启用状态（调用 Obsidian 内部 setCssEnabledStatus(name, enabled) 并刷新应用） */
export async function setSnippetEnabled(
	app: App,
	baseName: string,
	enabled: boolean,
): Promise<boolean> {
	const cc = asAppInternals(app).customCss;
	if (!cc?.setCssEnabledStatus) {
		logger.warn("[Chinese Plugin Market] app.customCss.setCssEnabledStatus 不可用，跳过切换");
		return false;
	}
	try {
		cc.setCssEnabledStatus(baseName, enabled);
		// setCssEnabledStatus 只改内部状态，不会自动重新加载 CSS；
		// 必须手动触发加载，否则命令面板 / 设置页开关看起来「点了没反应」。
		if (cc.requestLoadSnippetsDebouncer) cc.requestLoadSnippetsDebouncer();
		else if (cc.loadSnippets) cc.loadSnippets();
		const confirmed = await waitForSnippetState(app, baseName, enabled);
		if (!confirmed) {
			logger.warn("[Chinese Plugin Market] CSS 片段切换后状态未确认:", {
				baseName,
				expected: enabled,
				actual: listSnippets(app).find((snippet) => snippet.baseName === baseName)?.enabled,
			});
			return false;
		}
		return true;
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 切换 CSS 片段启用失败:", error);
		return false;
	}
}

/** 读取片段文件内容 */
export async function readSnippetContent(app: App, path: string): Promise<string> {
	return app.vault.adapter.read(path);
}

/** 写入（创建 / 覆盖）片段文件 */
export async function writeSnippet(
	app: App,
	baseName: string,
	content: string,
): Promise<void> {
	await app.vault.adapter.write(`${snippetDir(app)}/${baseName}.css`, content);
}

/** 删除片段文件（不存在则静默） */
export async function deleteSnippet(app: App, baseName: string): Promise<void> {
	const path = `${snippetDir(app)}/${baseName}.css`;
	if (await app.vault.adapter.exists(path)) {
		await app.vault.adapter.remove(path);
	}
}

/**
 * 重命名片段：复制内容到新文件 → 删除旧文件 → 同步启用状态。
 * 旧名仍启用则先启用新名再关闭旧名，避免闪烁与状态丢失。
 */
export async function renameSnippet(
	app: App,
	oldBase: string,
	newBase: string,
): Promise<void> {
	// 安全闸门：newBase 直接进 `${snippetDir}/${newBase}.css` 拼路径，
	// 必须在任何读写之前拦截 `../../` 之类越权目标（createSnippet 有同名校验，
	// 重命名入口历史上漏了，导致同级别 UI 两条写盘路径防护不对称）。
	if (!isValidSnippetBaseName(newBase)) {
		logger.warn("[Chinese Plugin Market] 拒绝重命名 CSS 片段：目标基名不合法", newBase);
		throw new Error(`非法的 CSS 片段基名：${newBase}`);
	}
	const dir = snippetDir(app);
	const content = await readSnippetContent(app, `${dir}/${oldBase}.css`);
	await writeSnippet(app, newBase, content);
	await deleteSnippet(app, oldBase);
	const wasEnabled = isSnippetEnabled(app, oldBase);
	if (wasEnabled) {
		await setSnippetEnabled(app, newBase, true);
		await setSnippetEnabled(app, oldBase, false);
	}
	// 文件名变了，重新对齐缓存清单供立即渲染（否则列表还是旧名）
	try {
		await refreshSnippets(app);
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 重命名后刷新 CSS 片段清单失败:", error);
	}
}

/** 在系统文件管理器中打开片段所在目录（桌面端；移动端静默失败） */
export function openSnippetInDefaultApp(app: App, path: string): void {
	try {
		const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
		if (!dir) return;
		const open = (app as unknown as {
			openWithDefaultApp?: (p: string) => void;
		}).openWithDefaultApp;
		if (typeof open === "function") open(dir);
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 系统打开 CSS 片段目录失败:", error);
	}
}

/**
 * 校验 CSS 片段基名（文件名去 .css）是否安全可写。
 *
 * 禁止空名、路径分隔符、上级目录引用（../）、超长，避免越权写盘。
 * UI 弹窗与 store 层共用，保证新建前拦截非法基名。
 */
export function isValidSnippetBaseName(base: string): boolean {
	const b = base.trim();
	if (!b) return false;
	if (b === "." || b === "..") return false;
	if (/[/\\]/.test(b)) return false;
	if (b.startsWith("..")) return false;
	if (b.length > 200) return false;
	return true;
}
