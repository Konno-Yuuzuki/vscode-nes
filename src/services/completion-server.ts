import * as vscode from "vscode";
import { CompletionClient } from "~/api/completion-client.ts";
import { config } from "~/core/config.ts";

const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_COOLDOWN_MS = 60_000;

export class CompletionServer implements vscode.Disposable {
	private consecutiveFailures = 0;
	private lastWarningAt = 0;
	private warned = false;
	private client: CompletionClient | null = null;

	getClient(): CompletionClient {
		if (!this.client) {
			this.client = new CompletionClient(config.serverUrl);
		}
		return this.client;
	}

	async ensureReachable(): Promise<boolean> {
		const ok = await this.getClient().ping();
		if (!ok) this.warnUnreachable();
		return ok;
	}

	reportSuccess(): void {
		this.consecutiveFailures = 0;
		this.warned = false;
	}

	reportFailure(): void {
		this.consecutiveFailures++;
		if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			this.warnUnreachable();
			this.consecutiveFailures = 0;
		}
	}

	private warnUnreachable(): void {
		const now = Date.now();
		if (this.warned && now - this.lastWarningAt < FAILURE_COOLDOWN_MS) return;
		this.warned = true;
		this.lastWarningAt = now;
		vscode.window.showWarningMessage(
			`NESweep: completion server is not reachable at ${config.serverUrl}. ` +
				"Start an OpenAI-compatible /v1/completions server (e.g. llama-server) " +
				"with the zeta model loaded.",
		);
	}

	dispose(): void {}
}
