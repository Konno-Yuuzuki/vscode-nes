import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import type { ApiClient } from "~/api/client.ts";
import { getRulesFilePath } from "~/api/rules.ts";
import { config } from "~/core/config";
import type { CompletionServer } from "~/services/completion-server.ts";

// Cycle through the four loading frames every LOADING_FRAME_MS. ~600ms
// per full cycle reads as activity without becoming distracting.
const LOADING_FRAMES = [
	"zeta-load-1",
	"zeta-load-2",
	"zeta-load-3",
	"zeta-load-4",
];
const LOADING_FRAME_MS = 150;

export class SweepStatusBar implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;
	private disposables: vscode.Disposable[] = [];
	private apiClient: ApiClient;
	private loadingTimer: ReturnType<typeof setInterval> | null = null;
	private loadingIndex = 0;
	private hintText = "";

	constructor(_context: vscode.ExtensionContext, apiClient: ApiClient) {
		this.apiClient = apiClient;
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100,
		);
		this.statusBarItem.command = "zeta.showMenu";
		this.updateStatusBar();

		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration("zeta.enabled") ||
					e.affectsConfiguration("zeta.autocompleteSnoozeUntil")
				) {
					this.updateStatusBar();
				}
			}),
			apiClient.onDidChangeProcessing(() => this.updateStatusBar()),
		);

		this.statusBarItem.show();
	}

	/** Set a hint text shown after the icon (e.g. keyboard shortcuts). */
	setHint(hint: string): void {
		this.hintText = hint;
		this.applyText(this.apiClient.isProcessing);
	}

	/** Clear the hint text. */
	clearHint(): void {
		this.hintText = "";
		this.applyText(this.apiClient.isProcessing);
	}

	private updateStatusBar(): void {
		const isEnabled = config.enabled;
		const isSnoozed = config.isAutocompleteSnoozed();
		const isProcessing = this.apiClient.isProcessing;

		if (isProcessing) {
			if (!this.loadingTimer) {
				this.loadingIndex = 0;
				this.loadingTimer = setInterval(() => {
					this.loadingIndex = (this.loadingIndex + 1) % LOADING_FRAMES.length;
					this.applyText(true);
				}, LOADING_FRAME_MS);
			}
		} else if (this.loadingTimer) {
			clearInterval(this.loadingTimer);
			this.loadingTimer = null;
		}

		this.applyText(isProcessing);
		this.statusBarItem.tooltip = this.buildTooltip(isEnabled, isSnoozed);

		if (!isEnabled || isSnoozed) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground",
			);
		} else {
			this.statusBarItem.backgroundColor = undefined;
		}
	}

	private applyText(loading: boolean): void {
		const icon = loading ? LOADING_FRAMES[this.loadingIndex] : "zeta-idle";
		const hint = this.hintText ? `  ${this.hintText}` : "";
		this.statusBarItem.text = `$(${icon})${hint}`;
	}

	private buildTooltip(isEnabled: boolean, isSnoozed: boolean): string {
		const status = isEnabled ? "Enabled" : "Disabled";
		const snoozeUntil = config.autocompleteSnoozeUntil;
		const snoozeLine = isSnoozed
			? `Snoozed Until: ${formatSnoozeTime(snoozeUntil)}`
			: "Snoozed: Off";
		return `Zeta\nStatus: ${status}\n${snoozeLine}\n\nClick to open menu`;
	}

	dispose(): void {
		if (this.loadingTimer) {
			clearInterval(this.loadingTimer);
			this.loadingTimer = null;
		}
		this.statusBarItem.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}

export function registerStatusBarCommands(
	_context: vscode.ExtensionContext,
	completionServer?: CompletionServer,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	disposables.push(
		vscode.commands.registerCommand("zeta.showMenu", async () => {
			const isEnabled = config.enabled;
			const isSnoozed = config.isAutocompleteSnoozed();

			interface MenuItem extends vscode.QuickPickItem {
				action: string;
			}

			const items: MenuItem[] = [
				{
					label: `$(${isEnabled ? "check" : "circle-outline"}) Autocomplete`,
					description: isEnabled ? "Enabled" : "Disabled",
					action: "toggleEnabled",
				},
				{
					label: isSnoozed
						? "$(play-circle) Resume Autocomplete"
						: "$(clock) Snooze Autocomplete",
					description: isSnoozed
						? "Resume suggestions immediately"
						: "Pause suggestions temporarily",
					action: isSnoozed ? "resumeSnooze" : "snooze",
				},
				{
					label: "$(plug) Check Server Connection",
					description: `Ping ${config.serverUrl}`,
					action: "checkBackend",
				},
			];

			const editor = vscode.window.activeTextEditor;
			const rulesPath = editor ? getRulesFilePath(editor.document) : null;
			if (editor && rulesPath) {
				const lang = editor.document.languageId;
				const limit = config.rulesMaxChars;
				let description: string;
				let overflow = false;
				const charCount = readRulesCharCount(rulesPath);
				if (charCount === null) {
					description = `No instructions yet — click to create ${path.basename(rulesPath)}`;
				} else {
					overflow = limit > 0 && charCount > limit;
					description = overflow
						? `${path.basename(rulesPath)} — ${charCount} chars (${charCount - limit} over)`
						: `${path.basename(rulesPath)} — ${charCount} chars`;
				}
				items.push({
					label: `$(${overflow ? "warning" : "edit"}) Edit Instructions for ${lang}`,
					description,
					action: "editInstructions",
				});
			}

			const selection = await vscode.window.showQuickPick(items, {
				placeHolder: "Zeta Settings",
				title: "Zeta",
			});

			if (selection) {
				switch (selection.action) {
					case "toggleEnabled":
						await vscode.commands.executeCommand("zeta.toggleEnabled");
						break;
					case "snooze":
						await handleSnooze();
						break;
					case "resumeSnooze":
						await handleResumeSnooze();
						break;
					case "checkBackend":
						if (completionServer) {
							const ok = await completionServer.ensureReachable();
							if (ok) {
								vscode.window.showInformationMessage(
									`Zeta server reachable at ${config.serverUrl}.`,
								);
							}
						}
						break;
					case "editInstructions":
						if (rulesPath) await openRulesFile(rulesPath);
						break;
				}
			}
		}),
	);

	disposables.push(
		vscode.commands.registerCommand("zeta.toggleEnabled", async () => {
			const inspection = config.inspect<boolean>("enabled");
			const current =
				inspection?.workspaceValue ??
				inspection?.globalValue ??
				inspection?.defaultValue ??
				true;
			await config.setEnabled(!current);

			// Hide any existing inline suggestions when disabling
			if (current) {
				await vscode.commands.executeCommand(
					"editor.action.inlineSuggest.hide",
				);
			}

			vscode.window.showInformationMessage(
				`Zeta autocomplete ${!current ? "enabled" : "disabled"}`,
			);
		}),
	);

	return disposables;
}

function formatSnoozeTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString();
}

async function handleSnooze(): Promise<void> {
	const options: Array<{ label: string; minutes: number }> = [
		{ label: "15 minutes", minutes: 15 },
		{ label: "30 minutes", minutes: 30 },
		{ label: "1 hour", minutes: 60 },
		{ label: "4 hours", minutes: 240 },
	];

	const selection = await vscode.window.showQuickPick(
		options.map((option) => ({
			label: option.label,
			description: `Pause autocomplete for ${option.label}`,
		})),
		{ title: "Snooze Zeta Autocomplete", placeHolder: "Choose duration" },
	);

	if (!selection) return;

	const selected = options.find((option) => option.label === selection.label);
	if (!selected) return;

	const until = Date.now() + selected.minutes * 60 * 1000;
	await config.setAutocompleteSnoozeUntil(
		until,
		vscode.ConfigurationTarget.Global,
	);
	await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
	vscode.window.showInformationMessage(
		`Zeta autocomplete snoozed until ${formatSnoozeTime(until)}.`,
	);
}

async function handleResumeSnooze(): Promise<void> {
	await config.setAutocompleteSnoozeUntil(0, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage("Zeta autocomplete resumed.");
}

// Match the diagnostic's notion of "chars": UTF-16 code units, which
// is what VS Code's selection counter and getText().length report. If
// the file is already open, prefer its in-memory text (it may have
// unsaved edits); otherwise read from disk.
function readRulesCharCount(rulesPath: string): number | null {
	const open = vscode.workspace.textDocuments.find(
		(d) => d.uri.scheme === "file" && d.uri.fsPath === rulesPath,
	);
	if (open) return open.getText().length;
	try {
		return fs.readFileSync(rulesPath, "utf8").length;
	} catch {
		return null;
	}
}

async function openRulesFile(rulesPath: string): Promise<void> {
	if (!fs.existsSync(rulesPath)) {
		fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
		fs.writeFileSync(rulesPath, "");
	}
	const doc = await vscode.workspace.openTextDocument(rulesPath);
	await vscode.window.showTextDocument(doc);
}
