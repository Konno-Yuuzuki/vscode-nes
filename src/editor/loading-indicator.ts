import * as vscode from "vscode";

import type { ApiClient } from "~/api/client.ts";

/**
 * A small inline decoration tag that appears near the cursor when a
 * completion request is in flight. Shows a rotating indicator and
 * "Zeta" label in the editor's ghost-text colour, giving the user
 * immediate visual feedback that the model is working.
 *
 * The tag is rendered as an `after` decoration on the cursor line
 * so it stays in the user's focal area without blocking the code.
 * A simple animation cycles through two rotation-frame characters
 * to convey activity without distracting.
 */

const LOADING_FRAMES = ["⟳", "⟲"];
const LOADING_FRAME_MS = 250;

export class LoadingIndicatorDecoration implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly apiClient: ApiClient;

	private frameIndex = 0;
	private loadingTimer: ReturnType<typeof setInterval> | null = null;
	private isProcessing = false;

	/** One decoration type per frame — we cycle by setting ranges on one
	 *  and clearing the others, avoiding dispose/recreate on every tick. */
	private readonly frameDecorations: vscode.TextEditorDecorationType[];

	constructor(apiClient: ApiClient) {
		this.apiClient = apiClient;

		// Pre-create one decoration type per frame. Each shows a different
		// character so the timer simply swaps which range-set is active.
		this.frameDecorations = LOADING_FRAMES.map((frame) =>
			vscode.window.createTextEditorDecorationType({
				after: {
					contentText: ` ${frame} Zeta`,
					color: new vscode.ThemeColor("editorGhostText.foreground"),
					fontWeight: "600",
				},
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			}),
		);

		this.disposables.push(
			apiClient.onDidChangeProcessing((processing) => {
				this.isProcessing = processing;
				if (processing) {
					this.startLoading();
				} else {
					this.stopLoading();
				}
			}),
			vscode.window.onDidChangeActiveTextEditor(() => {
				if (this.isProcessing) {
					this.showFrame(this.frameIndex);
				}
			}),
			...this.frameDecorations,
		);
	}

	private startLoading(): void {
		this.frameIndex = 0;
		this.showFrame(0);

		this.loadingTimer = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % LOADING_FRAMES.length;
			this.showFrame(this.frameIndex);
		}, LOADING_FRAME_MS);
	}

	private stopLoading(): void {
		if (this.loadingTimer) {
			clearInterval(this.loadingTimer);
			this.loadingTimer = null;
		}
		// Clear all frames from every editor
		for (const editor of vscode.window.visibleTextEditors) {
			for (const dec of this.frameDecorations) {
				editor.setDecorations(dec, []);
			}
		}
	}

	private showFrame(frame: number): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const cursorLine = editor.selection.active.line;
		const range = new vscode.Range(cursorLine, 0, cursorLine, 0);

		for (let i = 0; i < this.frameDecorations.length; i++) {
			editor.setDecorations(
				this.frameDecorations[i],
				i === frame ? [range] : [],
			);
		}
	}

	dispose(): void {
		this.stopLoading();
		for (const d of this.disposables) d.dispose();
	}
}