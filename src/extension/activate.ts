import * as vscode from "vscode";

import { ApiClient } from "~/api/client.ts";
import { config } from "~/core/config.ts";
import { disposeLogger, initLogger, logger } from "~/core/logger.ts";
import {
	type AcceptedInlineSuggestion,
	InlineEditProvider,
} from "~/editor/inline-edit-provider.ts";
import { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import { registerInlineCompletionItemProviderWithMetadata } from "~/editor/proposed-inline-edit.ts";
import {
	initSyntaxHighlighter,
	reloadTheme,
} from "~/editor/syntax-highlight-renderer.ts";
import { RulesDiagnostics } from "~/extension/rules-diagnostics.ts";
import {
	SweepStatusBar,
	registerStatusBarCommands,
} from "~/extension/status-bar.ts";
import { LoadingIndicatorDecoration } from "~/editor/loading-indicator.ts";
import { CompletionServer } from "~/services/completion-server.ts";
import { DocumentTracker } from "~/telemetry/document-tracker.ts";

let tracker: DocumentTracker;
let jumpEditManager: JumpEditManager;
let provider: InlineEditProvider;
let statusBar: SweepStatusBar;
let loadingIndicator: LoadingIndicatorDecoration;
let completionServer: CompletionServer;
let copilotStylePresentationWarningShown = false;

const COPILOT_STYLE_PROPOSED_API_EXTENSION_ID = "Yuuzuki.zeta-edit-prediction";

/** Candidate argv.json locations in priority order: --user-data-dir, then the
 *  default ~/.vscode/argv.json.  VS Code reads `enable-proposed-api` from the
 *  argv.json of the active user-data-dir, which does NOT go through the
 *  compiled-in product.json white-list (that embedded list is what actually
 *  gates proposed API on custom builds). */
function getArgvJsonCandidates(): string[] {
	const out: string[] = [];
	try {
		const argIndex = process.argv.indexOf("--user-data-dir");
		if (argIndex !== -1 && process.argv[argIndex + 1]) {
			out.push(
				require("node:path").join(
					process.argv[argIndex + 1],
					"argv.json",
				),
			);
		}
	} catch {}
	out.push(
		require("node:path").join(
			require("node:os").homedir(),
			".vscode",
			"argv.json",
		),
	);
	return out;
}

function argvJsonHasProposedApiConsent(): boolean {
	for (const file of getArgvJsonCandidates()) {
		try {
			if (!require("node:fs").existsSync(file)) continue;
			const content = require("node:fs").readFileSync(file, "utf8");
			const m = content.match(/"enable-proposed-api"\s*:\s*\[([^\]]*)\]/);
			if (
				m &&
				m[1].includes(`"${COPILOT_STYLE_PROPOSED_API_EXTENSION_ID}"`)
			) {
				return true;
			}
		} catch {}
	}
	return false;
}

function processHasProposedApiFlag(): boolean {
	const flag = `--enable-proposed-api=${COPILOT_STYLE_PROPOSED_API_EXTENSION_ID}`;
	return (
		process.argv.includes(flag) ||
		process.argv.some(
			(a, i) =>
				a === "--enable-proposed-api" &&
				process.argv[i + 1] === COPILOT_STYLE_PROPOSED_API_EXTENSION_ID,
		)
	);
}

/** Appends our extension id to argv.json's `enable-proposed-api` array,
 *  preserving JSONC comments/trailing commas. Returns true if the consent is
 *  present afterwards. */
function writeArgvJsonConsent(): boolean {
	for (const file of getArgvJsonCandidates()) {
		try {
			const fs = require("node:fs");
			const content = fs.existsSync(file)
				? fs.readFileSync(file, "utf8")
				: "{\n}\n";
			const entry = `"${COPILOT_STYLE_PROPOSED_API_EXTENSION_ID}"`;
			const m = content.match(/"enable-proposed-api"\s*:\s*\[([^\]]*)\]/);
			let next: string;
			if (m) {
				if (m[1].includes(entry)) return true;
				const ids = m[1]
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				ids.push(entry);
				next = content.replace(m[0], m[0].replace(m[1], ids.join(", ")));
			} else {
				const idx = content.indexOf("{");
				const tail = content.slice(idx + 1);
				const indent = tail.startsWith("\n	") ? "	" : "";
				next =
					content.slice(0, idx + 1) +
					`\n${indent}"enable-proposed-api": [${entry}],` +
					tail;
			}
			fs.writeFileSync(file, next, "utf8");
			return true;
		} catch {}
	}
	return false;
}

function maybeWarnAboutCopilotStylePresentation(): void {
	if (
		!config.useCopilotStyleNextEditPresentation ||
		copilotStylePresentationWarningShown
	) {
		return;
	}

	copilotStylePresentationWarningShown = true;
	if (isProposedApiEnabled()) {
		return;
	}
	// Auto-enable via argv.json (user-level, no admin rights needed); the
	// value takes effect after a full restart of VS Code.
	if (writeArgvJsonConsent()) {
		void vscode.window
			.showInformationMessage(
				"Zeta 需要 VS Code Proposed API 才能显示 Copilot 风格的多行编辑预览。" +
					"已自动写入授权配置(argv.json)，重启 VS Code 后生效。",
				"立即重启",
				"稍后",
			)
			.then((choice) => {
				if (choice === "立即重启") {
					void vscode.commands.executeCommand(
						"workbench.action.reloadWindow",
					);
				}
			});
	} else {
		void vscode.window.showWarningMessage(
			`Zeta 使用 Proposed API 显示多行编辑预览。请以 --enable-proposed-api=${COPILOT_STYLE_PROPOSED_API_EXTENSION_ID} 启动 VS Code，` +
				`或在 argv.json 的 "enable-proposed-api" 中添加 "${COPILOT_STYLE_PROPOSED_API_EXTENSION_ID}" 后重启。`,
		);
	}
}

export function isProposedApiEnabled(): boolean {
	if (processHasProposedApiFlag()) return true;
	if (argvJsonHasProposedApiConsent()) return true;
	return productJsonHasProposedApiConsent();
}

function productJsonHasProposedApiConsent(): boolean {
	try {
		const productPath = findProductJson();
		if (!productPath) return false;
		const content = JSON.parse(
			require("node:fs").readFileSync(productPath, "utf8"),
		);
		const ep = content.extensionEnabledApiProposals;
		return !!ep?.[COPILOT_STYLE_PROPOSED_API_EXTENSION_ID]?.includes(
			"inlineCompletionsAdditions",
		);
	} catch {
		return false;
	}
}

export function findProductJson(): string | null {
	const candidates = [
		vscode.env.appRoot
			? require("node:path").join(vscode.env.appRoot, "product.json")
			: null,
		process.env.VSCODE_APP_ROOT
			? require("node:path").join(process.env.VSCODE_APP_ROOT, "product.json")
			: null,
	];
	const knownPaths = [
		"D:\\\\Microsoft VS Code\\\\df53daabb1\\\\resources\\\\app\\\\product.json",
		"D:/Microsoft VS Code/df53daabb1/resources/app/product.json",
	];
	// Scan for versioned subdirectories (e.g. df53daabb1) when appRoot
	// points to a parent directory like D:\Microsoft VS Code\.
	if (vscode.env.appRoot) {
		const parent = require("node:path").dirname(vscode.env.appRoot);
		const grandparent = require("node:path").dirname(parent);
		try {
			for (const entry of require("node:fs").readdirSync(parent)) {
				const candidate = require("node:path").join(
					parent,
					entry,
					"resources",
					"app",
					"product.json",
				);
				if (require("node:fs").existsSync(candidate)) {
					knownPaths.push(candidate);
				}
		}
			// Also check grandparent (one level up)
			for (const entry of require("node:fs").readdirSync(grandparent)) {
				const candidate = require("node:path").join(
					grandparent,
					entry,
					"resources",
					"app",
					"product.json",
				);
				if (require("node:fs").existsSync(candidate)) {
					knownPaths.push(candidate);
				}
		}
		} catch {
			// readdir may fail for permission reasons; skip scan
		}
	}
	for (const p of [...candidates, ...knownPaths]) {
		if (p && require("node:fs").existsSync(p)) return p;
	}
	return null;
}

async function enableProposedApi(): Promise<void> {
	if (isProposedApiEnabled()) {
		void vscode.window.showInformationMessage(
			"Zeta proposed API is already enabled.",
		);
		return;
	}

	if (writeArgvJsonConsent()) {
		const choice = await vscode.window.showInformationMessage(
			"已写入 Proposed API 授权(argv.json)。重启 VS Code 后生效。",
			"立即重启",
		);
		if (choice === "立即重启") {
			void vscode.commands.executeCommand(
				"workbench.action.reloadWindow",
			);
		}
		return;
	}

	void vscode.window.showErrorMessage(
		`无法自动写入 argv.json。请手动：在 user-data-dir 的 argv.json 中为 "enable-proposed-api" 添加 "${COPILOT_STYLE_PROPOSED_API_EXTENSION_ID}"，` +
			`或使用 --enable-proposed-api=${COPILOT_STYLE_PROPOSED_API_EXTENSION_ID} 启动 VS Code。`,
	);
}

export function activate(context: vscode.ExtensionContext) {
	const logChannel = initLogger();
	logger.info("Zeta activated");
	errorMonitor.init();
	initSyntaxHighlighter();

	tracker = new DocumentTracker(context);
	completionServer = new CompletionServer();
	const apiClient = new ApiClient(completionServer);
	jumpEditManager = new JumpEditManager();
	provider = new InlineEditProvider(tracker, jumpEditManager, apiClient);
	const refreshTheme = () => {
		reloadTheme();
		jumpEditManager.refreshJumpEditDecorations();
	};

	const providerDisposable = registerInlineCompletionItemProviderWithMetadata(
		{ pattern: "**/*" },
		provider,
		{
			displayName: "Zeta",
			groupId: "nes",
			debounceDelayMs: 0,
		},
	);

	const triggerCommand = vscode.commands.registerCommand(
		"zeta.triggerNextEdit",
		() => {
			vscode.commands.executeCommand("editor.action.inlineEdit.trigger");
		},
	);


	const acceptInlineEditByTabCommand = vscode.commands.registerCommand(
		"zeta.acceptInlineEditByTab",
		() => {
			// Try the native NES accept first; if nothing NES is visible,
			// fall back to the regular inline-completion accept. Either way,
			// trigger the next prediction after acceptance.
			void vscode.commands
				.executeCommand("editor.action.inlineEdit.accept")
				.then(
					() => provider.handleInlineAccept(),
					() => {
						void vscode.commands
							.executeCommand(
								"editor.action.inlineSuggest.accept",
							)
							.then(
								() => provider.handleInlineAccept(),
								() => provider.handleInlineAccept(),
							);
					},
				);
		},
	);


	const acceptJumpEditCommand = vscode.commands.registerCommand(
		"zeta.acceptJumpEdit",
		() => jumpEditManager.acceptJumpEdit(),
	);

	const acceptJumpEditLineCommand = vscode.commands.registerCommand(
		"zeta.acceptJumpEditLine",
		() => jumpEditManager.acceptJumpEditLine(),
	);

	const acceptInlineEditCommand = vscode.commands.registerCommand(
		"zeta.acceptInlineEdit",
		(acceptedSuggestion: AcceptedInlineSuggestion | undefined) => {
			provider.handleInlineAccept(acceptedSuggestion);
		},
	);

	const dismissJumpEditCommand = vscode.commands.registerCommand(
		"zeta.dismissJumpEdit",
		() => jumpEditManager.dismissJumpEdit(),
	);

	const enableProposedApiCommand = vscode.commands.registerCommand(
		"zeta.enableProposedApi",
		() => enableProposedApi(),
	);

	const triggerAtCursorCommand = vscode.commands.registerCommand(
		"zeta.triggerCompletionAtCursor",
		() => {
			logger.info("Manual trigger at cursor requested");
			provider.forceTriggerRequested = true;
			void vscode.commands
				.executeCommand("editor.action.inlineSuggest.hide")
				.then(() =>
					vscode.commands.executeCommand(
						"editor.action.inlineSuggest.trigger",
					),
				);
		},
	);

	statusBar = new SweepStatusBar(context, apiClient);
	loadingIndicator = new LoadingIndicatorDecoration(apiClient);
	const statusBarCommands = registerStatusBarCommands(
		context,
		completionServer,
	);
	const rulesDiagnostics = new RulesDiagnostics();

	const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
		provider.handleDocumentChangeForCursorRestore(event);
		if (event.document === vscode.window.activeTextEditor?.document) {
			tracker.trackChange(event);
		}
	});
	const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
		apiClient.handleDocumentSaved(document);
	});

	const themeChangeListener = vscode.window.onDidChangeActiveColorTheme(() => {
		refreshTheme();
	});
	const themeConfigListener = vscode.workspace.onDidChangeConfiguration(
		(event) => {
			if (
				event.affectsConfiguration("zeta.useCopilotStyleNextEditPresentation")
			) {
				if (config.useCopilotStyleNextEditPresentation) {
					maybeWarnAboutCopilotStylePresentation();
				} else {
					copilotStylePresentationWarningShown = false;
				}
		}

			if (event.affectsConfiguration("workbench.colorTheme")) {
				// The colorTheme setting can update slightly after the active theme event.
				setTimeout(() => {
					refreshTheme();
				}, 0);
		}
		},
	);

	const handleCursorMove = (editor: vscode.TextEditor): void => {
		void provider.handleCursorMove(editor.document, editor.selection.active);
		jumpEditManager.handleCursorMove(editor.selection.active);
	};

	const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(
		(editor) => {
			if (editor) {
				tracker.setActiveFile(editor.document);
				tracker.trackFileVisit(editor.document);
				handleCursorMove(editor);
			} else {
				tracker.setActiveFile(null);
		}
		},
	);

	const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection(
		(event) => {
			// VS Code does not guarantee that the TextEditor object attached to a
			// selection event is the same object instance as activeTextEditor.
			// Compare documents instead; object-identity filtering drops genuine
			// keyboard/mouse cursor moves and prevents context-exit retriggers.
			const activeDocument = vscode.window.activeTextEditor?.document;
			if (
				!activeDocument ||
				event.textEditor.document.uri.toString() !==
					activeDocument.uri.toString()
			) {
				return;
		}

			tracker.trackSelectionChange(event.textEditor.document, event.selections);
			for (const selection of event.selections) {
				tracker.trackCursorMovement(
					event.textEditor.document,
					selection.active,
				);
		}
			handleCursorMove(event.textEditor);
		},
	);

	if (vscode.window.activeTextEditor) {
		tracker.setActiveFile(vscode.window.activeTextEditor.document);
		tracker.trackFileVisit(vscode.window.activeTextEditor.document);
		handleCursorMove(vscode.window.activeTextEditor);
	}

	context.subscriptions.push(
		providerDisposable,
		triggerCommand,
		acceptInlineEditByTabCommand,
		acceptJumpEditLineCommand,
		acceptInlineEditCommand,
		dismissJumpEditCommand,
		enableProposedApiCommand,
		changeListener,
		saveListener,
		editorChangeListener,
		selectionChangeListener,
		themeChangeListener,
		themeConfigListener,
		tracker,
		jumpEditManager,
		statusBar,
		completionServer,
		rulesDiagnostics,
		logChannel,
		...statusBarCommands,
	);

	// Probe the completion server once at startup so the user gets an early
	// warning if it's down or the URL is wrong; the actual model load is
	// deferred to the first completion.
	maybeWarnAboutCopilotStylePresentation();
	void completionServer.ensureReachable();
}

export function deactivate() {
	// Persist the tracker tail before VS Code disposes subscriptions —
	// covers manual reloads / window closes inside the 5-min AFK window.
	void tracker?.flush();
	disposeLogger();
	errorMonitor.dispose();
}

/**
 * Lightweight error monitor that collects errors in memory and surfaces
 * a summary when the count exceeds a threshold.
 */
const ERROR_MONITOR_MAX = 20;
class ErrorMonitor {
	private errors: Array<{ message: string; timestamp: number }> = [];
	private disposable: vscode.Disposable | null = null;
	private warned = false;

	init(): void {
		const origError = logger.error.bind(logger);
		logger.error = (...args: unknown[]) => {
			this.record(fmt(args));
			origError(...args);
		};
		this.disposable = vscode.commands.registerCommand(
			"zeta.showErrorLog",
			() => this.show(),
		);
	}

	record(message: string): void {
		this.errors.push({ message, timestamp: Date.now() });
		if (this.errors.length > ERROR_MONITOR_MAX) {
			this.errors.shift();
		}
		if (this.errors.length >= 5 && !this.warned) {
			this.warned = true;
			void vscode.window.showWarningMessage(
				`Zeta has encountered ${this.errors.length} errors. Run "Zeta: Show Error Log" for details.`,
			);
		}
	}

	show(): void {
		if (this.errors.length === 0) {
			void vscode.window.showInformationMessage("No Zeta errors recorded.");
			return;
		}
		const text = this.errors
			.map(
				(e) => `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.message}`,
			)
			.join("\n");
		void vscode.window.showInformationMessage(
			`Zeta Error Log (${this.errors.length} entries):\n${text}`,
			{ modal: true },
		);
	}

	dispose(): void {
		this.disposable?.dispose();
	}
}

const errorMonitor = new ErrorMonitor();