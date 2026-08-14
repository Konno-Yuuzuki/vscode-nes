import * as http from "node:http";
import * as https from "node:https";

export interface CompletionRequest {
	model: string;
	prompt: string;
	temperature: number;
	maxTokens: number;
	stop: string[];
	timeoutMs: number;
}

export interface CompletionResult {
	text: string;
	finishReason: string;
	promptEvalCount?: number;
	evalCount?: number;
}

interface OpenAICompletionResponse {
	choices?: Array<{
		text?: string;
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
}

export class CompletionClient {
	constructor(private readonly baseUrl: string) {}

	async complete(
		req: CompletionRequest,
		signal?: AbortSignal,
	): Promise<CompletionResult> {
		const body = {
			model: req.model,
			prompt: req.prompt,
			temperature: req.temperature,
			max_tokens: req.maxTokens,
			stop: req.stop,
			stream: false,
		};

		return this.sendRequest(body, req.timeoutMs, signal);
	}

	/**
	 * Stream a completion via SSE. Calls `onToken(result)` with each partial
	 * result (accumulated text), then resolves the promise with the final result.
	 */
	async completeStream(
		req: CompletionRequest,
		signal: AbortSignal | undefined,
		onToken: (partial: CompletionResult) => void,
	): Promise<CompletionResult> {
		const body = {
			model: req.model,
			prompt: req.prompt,
			temperature: req.temperature,
			max_tokens: req.maxTokens,
			stop: req.stop,
			stream: true,
		};

		return this.sendRequest(body, req.timeoutMs, signal, onToken);
	}

	private async sendRequest(
		body: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
		onToken?: (partial: CompletionResult) => void,
	): Promise<CompletionResult> {
		const payload = JSON.stringify(body);
		const url = new URL("/v1/completions", this.baseUrl);
		const transport = url.protocol === "https:" ? https : http;
		const port = url.port || (url.protocol === "https:" ? 443 : 80);

		const result: CompletionResult = {
			text: "",
			finishReason: "stop",
		};

		return new Promise((resolve, reject) => {
			let settled = false;
			let responseEnded = false;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			let totalTimer: ReturnType<typeof setTimeout> | undefined;
			let streamStarted = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};

			// In streaming mode the timeout is an IDLE timeout: it resets on
			// every received chunk, so a slow-but-progressing generation is not
			// killed. A separate total cap (timeoutMs * 6) guards against the
			// server sending nothing at all. Non-streaming keeps a hard total
			// timeout.
			const isStreaming = body.stream === true;
			const totalBudgetMs = isStreaming ? timeoutMs * 6 : timeoutMs;

			const armIdleTimer = () => {
				if (!isStreaming) return;
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					httpReq.destroy();
					finish(() =>
						reject(
							new Error(
								`Completion stream stalled: no data for ${timeoutMs}ms`,
							),
						),
					);
				}, timeoutMs);
			};

			const armTotalTimer = () => {
				totalTimer = setTimeout(() => {
					const err = new Error(
						`Completion request timed out after ${totalBudgetMs}ms` +
							(isStreaming
								? ` (stream${streamStarted ? ", receiving" : " waiting for first chunk"})`
								: ""),
					);
					finish(() => {
						httpReq.destroy();
						reject(err);
					});
				}, totalBudgetMs);
			};

			const reqOptions: http.RequestOptions = {
				hostname: url.hostname,
				port,
				path: `${url.pathname}${url.search}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
				},
				timeout: timeoutMs,
			};

			const httpReq = transport.request(reqOptions, (res) => {
				const isStreaming = body.stream === true;
				let data = "";
				let lastEmit = 0;

				const emitToken = () => {
					if (!onToken) return;
					const now = Date.now();
					if (now - lastEmit < 80) return;
					lastEmit = now;
					onToken({ ...result });
				};

				/** Parse a single SSE `data: {...}` JSON line and update `result`. */
				const parseSseJson = (jsonStr: string) => {
					try {
						const parsed = JSON.parse(jsonStr) as OpenAICompletionResponse;
						const choice = parsed.choices?.[0];
						if (choice?.text) {
							result.text += choice.text;
							result.finishReason = choice.finish_reason ?? "stop";
						}
						if (choice?.finish_reason) {
							result.finishReason = choice.finish_reason;
						}
						// Usage may arrive in the last SSE message (before [DONE])
						// even when choices[0].text is absent.
						if (parsed.usage?.prompt_tokens !== undefined) {
							result.promptEvalCount = parsed.usage.prompt_tokens;
						}
						if (parsed.usage?.completion_tokens !== undefined) {
							result.evalCount = parsed.usage.completion_tokens;
						}
					} catch {
						// Incomplete JSON line — keep accumulating
					}
				};

				const onResponseData = (chunk: Buffer | string) => {
					const chunkStr = chunk.toString();
					if (isStreaming) {
						streamStarted = true;
						armIdleTimer();
						data += chunkStr;
						const lines = data.split("\n");
						data = lines.pop() ?? "";
						for (const line of lines) {
							const trimmed = line.trim();
							if (!trimmed || !trimmed.startsWith("data:")) continue;
							const jsonStr = trimmed.slice(5).trim();
							if (jsonStr === "[DONE]") continue;
							parseSseJson(jsonStr);
							emitToken();
						}
					} else {
						data += chunkStr;
					}
				};

				const onResponseEnd = () => {
					responseEnded = true;
					if (res.statusCode !== 200) {
						finish(() =>
							reject(
								new Error(
									`Completion request failed (${res.statusCode}): ${data}`,
								),
							),
						);
						return;
					}
					if (!isStreaming) {
						parseSseJson(data);
					}
					// Final emit: send the complete result
					if (onToken) onToken({ ...result });
					finish(() => resolve(result));
				};

				const onResponseAborted = () => {
					finish(() =>
						reject(
							new Error(
								`Completion response aborted (${res.statusCode ?? "unknown"}): ${data}`,
							),
						),
					);
				};

				const onResponseError = (error: Error) => {
					finish(() =>
						reject(new Error(`Completion response error: ${error.message}`)),
					);
				};

				const onResponseClose = () => {
					if (responseEnded || res.complete) return;
					finish(() =>
						reject(
							new Error(
								`Completion response closed before completion (${res.statusCode ?? "unknown"}): ${data}`,
							),
						),
					);
				};

				res.on("data", onResponseData);
				res.on("end", onResponseEnd);
				res.on("aborted", onResponseAborted);
				res.on("error", onResponseError);
				res.on("close", onResponseClose);
			});

			const onError = (error: Error) => {
				finish(() =>
					reject(new Error(`Completion request error: ${error.message}`)),
				);
			};

			const onAbort = () => {
				const abortError = new Error("Request aborted");
				abortError.name = "AbortError";
				finish(() => {
					httpReq.destroy();
					reject(abortError);
				});
			};

			const cleanup = () => {
				if (idleTimer) {
					clearTimeout(idleTimer);
					idleTimer = undefined;
				}
				if (totalTimer) {
					clearTimeout(totalTimer);
					totalTimer = undefined;
				}
				httpReq.off("timeout", onError);
				if (signal) signal.removeEventListener("abort", onAbort);
			};

			httpReq.on("error", onError);
			// http "timeout" (socket inactivity) is handled by idleTimer in
			// streaming mode; non-streaming requests keep it as a socket-level
			// guard alongside the total timer.
			if (!isStreaming) httpReq.on("timeout", () => httpReq.destroy());

			if (isStreaming) {
				armIdleTimer();
				armTotalTimer();
			} else {
				armTotalTimer();
			}
			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort);
			}

			httpReq.write(payload);
			httpReq.end();
		});
	}

	async ping(timeoutMs = 1500): Promise<boolean> {
		return new Promise((resolve) => {
			const url = new URL("/health", this.baseUrl);
			const transport = url.protocol === "https:" ? https : http;
			const port = url.port || (url.protocol === "https:" ? 443 : 80);
			const req = transport.get(
				{
					hostname: url.hostname,
					port,
					path: url.pathname,
					timeout: timeoutMs,
				},
				(res) => {
					res.resume();
					resolve(
						res.statusCode !== undefined &&
							res.statusCode >= 200 &&
							res.statusCode < 500,
					);
				},
			);
			req.on("error", () => resolve(false));
			req.on("timeout", () => {
				req.destroy();
				resolve(false);
			});
		});
	}
}
