/**
 * 本地语义 worker 单例的释放语义（泄漏回归）。
 *
 * 背景：worker 是独立线程，其 WASM 模型不随 JS 上下文 GC。自我更新走
 * disable → enable（不重启 Obsidian），若卸载时不 terminate，旧 worker 会一直驻留，
 * 且新实例（全新 JS 模块，instances 是新表）会另建 worker 并重新加载模型
 * → 每更新一次泄漏一份模型内存，表现为「更新后打开整个 Obsidian 卡一段时间」。
 *
 * 这里只验证「单例表被清空」这一契约：WorkerLocalBackend 构造函数不做任何 IO
 * （worker 懒启动于 init/bootWorker），故 jsdom 下可安全创建实例并断言释放。
 */
import { describe, it, expect, afterEach } from "vitest";
import { WorkerLocalBackend } from "@semantic/workers/worker-backend";

describe("WorkerLocalBackend 单例释放", () => {
	afterEach(() => {
		WorkerLocalBackend.disposeAllShared();
	});

	it("同 model+镜像源复用同一实例（释放前的既有语义）", () => {
		const a = WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small" });
		const b = WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small" });
		expect(a).toBe(b);
	});

	it("disposeAllShared 清空单例表：释放后 getShared 会新建实例而非复用旧的", () => {
		const first = WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small" });
		const released = WorkerLocalBackend.disposeAllShared();
		expect(released).toBeGreaterThanOrEqual(1);
		const after = WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small" });
		expect(after).not.toBe(first);
	});

	it("镜像源不同的实例一并释放（切镜像后旧 worker 不残留）", () => {
		WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small", remoteHost: "https://hf-mirror.com/" });
		WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small", remoteHost: "https://huggingface.co/" });
		expect(WorkerLocalBackend.disposeAllShared()).toBe(2);
		// 再次释放应为空操作（幂等，便于 onunload 重复调用）
		expect(WorkerLocalBackend.disposeAllShared()).toBe(0);
	});
});
