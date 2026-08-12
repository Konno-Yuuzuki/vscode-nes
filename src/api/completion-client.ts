import { EventEmitter } from "node:events";
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
			let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
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

				const onResponseData = (chunk: Buffer | string) => {
					const chunkStr = chunk.toString();
					if (isStreaming) {
						// Parse SSE events: "data: {...}\n\n"
						data += chunkStr;
						const lines = data.split("\n");
						data = lines.pop() ?? "";
						for (const line of lines) {
							const trimmed = line.trim();
							if (!trimmed || !trimmed.startsWith("data:")) continue;
							const jsonStr = trimmed.slice(5).trim();
							if (jsonStr === "[DONE]") continue;
							try {
								const parsed = JSON.parse(jsonStr) as OpenAICompletionResponse;
								const choice = parsed.choices?.[0];
								if (choice?.text) {
									result.text += choice.text;
									result.finishReason = choice.finish_reason ?? "stop";
									if (parsed.usage?.prompt_tokens !== undefined) {
										result.promptEvalCount = parsed.usage.prompt_tokens;
									}
									if (parsed.usage?.completion_tokens !== undefined) {
										result.evalCount = parsed.usage.completion_tokens;
									}
									emitToken();
								}
								if (choice?.finish_reason) {
									result.finishReason = choice.finish_reason;
								}
							} catch {
								// Incomplete JSON line — keep accumulating
							}
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
						try {
							const parsed = JSON.parse(data) as OpenAICompletionResponse;
							const choice = parsed.choices?.[0];
							result.text = choice?.text ?? "";
							result.finishReason = choice?.finish_reason ?? "stop";
							if (parsed.usage?.prompt_tokens !== undefined) {
								result.promptEvalCount = parsed.usage.prompt_tokens;
							}
							if (parsed.usage?.completion_tokens !== undefined) {
								result.evalCount = parsed.usage.completion_tokens;
							}
						} catch {
							finish(() =>
								reject(new Error("Failed to parse completion response")),
							);
							return;
						}
					}
					// Final emit for streaming: send the complete result
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

			const onTimeout = () => {
				const err = new Error(
					`Completion request timed out after ${timeoutMs}ms`,
				);
				finish(() => {
					httpReq.destroy();
					reject(err);
				});
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
				if (deadlineTimer) {
					clearTimeout(deadlineTimer);
					deadlineTimer = undefined;
				}
				httpReq.off("timeout", onTimeout);
				if (signal) signal.removeEventListener("abort", onAbort);
			};

			httpReq.on("error", onError);
			httpReq.on("timeout", onTimeout);
			deadlineTimer = setTimeout(onTimeout, timeoutMs);
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
