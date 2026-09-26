/**
 * 重命名 CSS 片段的轻量弹窗。
 *
 * 仅取一个新的基名（不含 .css 后缀），由宿主层（plugin）负责实际文件重命名、
 * 同步启用状态与元数据 key。弹窗本身不碰文件系统，保持纯净。
 */

import { App, Modal, Setting } from "obsidian";

export class SnippetRenameModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private readonly oldBase: string,
		private readonly onSubmit: (newBase: string) => void,
	) {
		super(app);
		this.value = oldBase;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "重命名 CSS 片段" });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `当前名称：${this.oldBase}.css（无需输入后缀）`,
		});

		new Setting(contentEl)
			.setName("新名称")
			.addText((text) => {
				text.setValue(this.value).onChange((v) => {
					this.value = v;
				});
				text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
					// IME 确认候选的 Enter 不提交重命名（isComposing 守卫）
					if (event.key === "Enter" && !event.isComposing) this.commit();
				});
			});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("确定").setCta().onClick(() => this.commit()),
			)
			.addButton((btn) => btn.setButtonText("取消").onClick(() => this.close()));
	}

	private commit(): void {
		const next = this.value.trim().replace(/\.css$/i, "");
		if (!next || next === this.oldBase) {
			this.close();
			return;
		}
		this.onSubmit(next);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
