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
	registerStatusBarCommands,
	SweepStatusBar,
} from "~/extension/status-bar.ts";
import { CompletionServer } from "~/services/completion-server.ts";
import { DocumentTracker } from "~/telemetry/document-tracker.ts";

let tracker: DocumentTracker;
let jumpEditManager: JumpEditManager;
let provider: InlineEditProvider;
let statusBar: SweepStatusBar;
let completionServer: CompletionServer;
let copilotStylePresentationWarningShown = false;

const COPILOT_STYLE_PROPOSED_API_EXTENSION_ID = "sr-team.nesweep";

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
	// Show a modal dialog with Enable/Never/Later options, matching the
	// original ucp-style flow. The user picks "Enable" → UAC prompt →
	// product.json updated → restart prompt.
	void vscode.window
		.showWarningMessage(
			"NESweep uses the proposed inlineCompletionsAdditions API to display Copilot-style inline edits. " +
				"Enabling it modifies product.json in the current VS Code installation and requires administrator permission. " +
				"Without it, Tab-accepted jump edits still work, but the inline edit presentation is not displayed.",
			{ modal: true },
			{ title: "Enable", isCloseAffordance: false },
			{ title: "Never Remind Again", isCloseAffordance: false },
			{ title: "Later", isCloseAffordance: true },
		)
		.then((selection) => {
			if (!selection) return;
			if (selection.title === "Enable") {
				void enableProposedApi();
			} else if (selection.title === "Never Remind Again") {
				// Dismissed permanently — reset the flag so the warning stays
				// hidden even if the user later enables the setting again.
				copilotStylePresentationWarningShown = true;
			}
			// "Later" — just dismiss; the warning will show again on next restart.
		});
}

export function isProposedApiEnabled(): boolean {
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
			"NESweep proposed API is already enabled.",
		);
		return;
	}

	const productPath = findProductJson();
	if (!productPath) {
		void vscode.window.showErrorMessage(
			"Cannot find VS Code product.json. Use --enable-proposed-api=sr-team.nesweep to start VS Code.",
		);
		return;
	}

	const selection = await vscode.window.showWarningMessage(
		"Enable NESweep Copilot-style next-edit presentation?",
		{
			modal: true,
			detail:
				"This will modify product.json in the VS Code installation directory and requires administrator permission.",
		},
		"Enable",
		"Cancel",
	);
	if (selection !== "Enable") return;

	// Use PowerShell to modify product.json with admin rights
	const script = `
$p = '${productPath.replace(/\\/g, "\\\\")}'
$c = Get-Content $p -Raw -Encoding UTF8
$d = $c | ConvertFrom-Json
if (-not $d.extensionEnabledApiProposals) {
  $d | Add-Member -NotePropertyName "extensionEnabledApiProposals" -NotePropertyValue @{} -Force
}
if (-not $d.extensionEnabledApiProposals."sr-team.nesweep") {
  $d.extensionEnabledApiProposals | Add-Member -NotePropertyName "sr-team.nesweep" -NotePropertyValue @("inlineCompletionsAdditions") -Force
  $n = $d | ConvertTo-Json -Depth 10
  # Write UTF-8 without BOM
  [System.IO.File]::WriteAllText($p, $n, [System.Text.UTF8Encoding]::new($false))
  Write-Host "OK"
} else {
  Write-Host "ALREADY"
}
`;
	const b64 = Buffer.from(script, "utf16le").toString("base64");
	const proc = require("node:child_process").spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-EncodedCommand", b64],
		{ windowsHide: true },
	);

	await new Promise<void>((resolve) => {
		proc.on("exit", () => resolve());
		proc.on("error", () => resolve());
		setTimeout(() => resolve(), 30000);
	});

	if (isProposedApiEnabled()) {
		void vscode.window.showInformationMessage(
			"NESweep proposed API enabled. Please restart VS Code completely for the change to take effect.",
		);
		// Show restart prompt
		await vscode.window.showInformationMessage(
			"Restart VS Code now to apply the change?",
			"Restart Later",
		);
	} else {
		void vscode.window.showErrorMessage(
			"Failed to enable proposed API. Use --enable-proposed-api=sr-team.nesweep to start VS Code.",
		);
	}
}

export function activate(context: vscode.ExtensionContext) {
	const logChannel = initLogger();
	logger.info("NESweep activated");
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
			displayName: "NESweep",
			groupId: "nes",
			debounceDelayMs: 0,
		},
	);

	const triggerCommand = vscode.commands.registerCommand(
		"sweep.triggerNextEdit",
		() => {
			vscode.commands.executeCommand("editor.action.inlineEdit.trigger");
		},
	);

	const acceptJumpEditCommand = vscode.commands.registerCommand(
		"sweep.acceptJumpEdit",
		() => jumpEditManager.acceptJumpEdit(),
	);

	const acceptJumpEditLineCommand = vscode.commands.registerCommand(
		"sweep.acceptJumpEditLine",
		() => jumpEditManager.acceptJumpEditLine(),
	);

	const acceptInlineEditCommand = vscode.commands.registerCommand(
		"sweep.acceptInlineEdit",
		(acceptedSuggestion: AcceptedInlineSuggestion | undefined) => {
			provider.handleInlineAccept(acceptedSuggestion);
		},
	);

	const dismissJumpEditCommand = vscode.commands.registerCommand(
		"sweep.dismissJumpEdit",
		() => jumpEditManager.dismissJumpEdit(),
	);

	const enableProposedApiCommand = vscode.commands.registerCommand(
		"sweep.enableProposedApi",
		() => enableProposedApi(),
	);

	statusBar = new SweepStatusBar(context, apiClient);
	const statusBarCommands = registerStatusBarCommands(
		context,
		completionServer,
	);
	const rulesDiagnostics = new RulesDiagnostics();

	const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
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
				event.affectsConfiguration("sweep.useCopilotStyleNextEditPresentation")
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
		acceptJumpEditCommand,
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
			"sweep.showErrorLog",
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
				`NESweep has encountered ${this.errors.length} errors. Run "NESweep: Show Error Log" for details.`,
			);
		}
	}

	show(): void {
		if (this.errors.length === 0) {
			void vscode.window.showInformationMessage("No NESweep errors recorded.");
			return;
		}
		const text = this.errors
			.map(
				(e) => `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.message}`,
			)
			.join("\n");
		void vscode.window.showInformationMessage(
			`NESweep Error Log (${this.errors.length} entries):\n${text}`,
			{ modal: true },
		);
	}

	dispose(): void {
		this.disposable?.dispose();
	}
}

const errorMonitor = new ErrorMonitor();
