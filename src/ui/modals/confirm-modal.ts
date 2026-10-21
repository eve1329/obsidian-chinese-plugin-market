/**
 * 通用二次确认弹窗。
 *
 * 项目里有多处「一次点击即不可逆」的操作：卸载插件会递归删除插件目录（含该插件
 * 自身配置数据）、清除缓存会丢弃全部译文资产。此前这些入口都只有一个红色按钮，
 * 没有任何确认 —— 而 `.setDestructive()` 只是着色，不构成交互确认。
 *
 * 本组件统一承载这类确认，并强制两个安全默认：
 * - 打开后焦点落在「取消」而非「确定」：避免用户连按 Enter 或凭肌肉记忆误执行；
 * - 「取消」排在确认按钮左侧，与破坏性操作的谨慎语义一致。
 *
 * 关闭（Esc / 点遮罩 / 点取消）一律视为取消，通过 onCancel 回调告知调用方，
 * 保证调用方用 `await` 等待时不会永久挂起。
 */

import { App, Modal, Setting } from "obsidian";
import { makeT } from "@shared/i18n";

export interface ConfirmOptions {
	app: App;
	/** 标题（建议包含被操作对象名，如「卸载「Dataview」？」） */
	title: string;
	/** 正文：必须写清「将删除什么 + 是否可恢复」 */
	message: string;
	confirmText?: string;
	cancelText?: string;
	/** 危险操作：确认按钮用警示色 */
	danger?: boolean;
	/** 用户明确点了确认 */
	onConfirm: () => void | Promise<void>;
	/** 用户取消（点取消 / Esc / 点遮罩） */
	onCancel?: () => void;
}

export class ConfirmModal extends Modal {
	private confirmed = false;
	private cancelBtnEl: HTMLElement | null = null;

	constructor(private readonly opts: ConfirmOptions) {
		super(opts.app);
	}

	onOpen(): void {
		const t = makeT();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pt-confirm-modal");
		contentEl.createEl("h3", { text: this.opts.title });
		if (this.opts.message) {
			contentEl.createEl("p", { cls: "pt-confirm-message", text: this.opts.message });
		}

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText(this.opts.cancelText ?? t("action.cancel"));
				btn.onClick(() => this.close());
				this.cancelBtnEl = btn.buttonEl;
			})
			.addButton((btn) => {
				btn.setButtonText(this.opts.confirmText ?? t("action.ok"));
				if (this.opts.danger) btn.setWarning();
				else btn.setCta();
				btn.onClick(() => {
					this.confirmed = true;
					this.close();
					void this.opts.onConfirm();
				});
			});

		// 安全默认：焦点给「取消」。破坏性操作不应因一次误按 Enter 就执行。
		this.cancelBtnEl?.focus();
	}

	onClose(): void {
		// 未点确认即关闭（Esc / 遮罩 / 取消按钮）→ 告知调用方按取消处理，
		// 否则 await 确认结果的调用方会永久挂起。
		if (!this.confirmed) this.opts.onCancel?.();
		this.contentEl.empty();
	}
}
