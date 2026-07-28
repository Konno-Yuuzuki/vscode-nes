import { afterEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { CompletionClient } from "~/api/completion-client.ts";

const servers: http.Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) reject(error);
						else resolve();
					});
					server.closeAllConnections();
				}),
		),
	);
});

async function listen(
	handler: http.RequestListener,
): Promise<{ server: http.Server; baseUrl: string }> {
	const server = http.createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("CompletionClient", () => {
	test("rejects a prematurely aborted HTTP response without waiting for timeout", async () => {
		const { baseUrl } = await listen((_request, response) => {
			response.writeHead(502, { "Content-Type": "text/plain" });
			response.flushHeaders();
			response.write("upstream request cancelled");
			const socket = response.socket;
			setTimeout(() => socket?.destroy(), 20);
		});
		const client = new CompletionClient(baseUrl);
		const startedAt = Date.now();

		await expect(
			client.complete({
				model: "zeta-2.1",
				prompt: "prompt",
				temperature: 0,
				maxTokens: 32,
				stop: [],
				timeoutMs: 2_000,
			}),
		).rejects.toThrow(/aborted|closed|socket hang up/i);

		expect(Date.now() - startedAt).toBeLessThan(500);
	});

	test("keeps the request deadline active after response headers arrive", async () => {
		const { baseUrl } = await listen((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.flushHeaders();
			response.write('{"choices":[');
		});
		const client = new CompletionClient(baseUrl);
		const startedAt = Date.now();

		await expect(
			client.complete({
				model: "zeta-2.1",
				prompt: "prompt",
				temperature: 0,
				maxTokens: 32,
				stop: [],
				timeoutMs: 100,
			}),
		).rejects.toThrow("Completion request timed out after 100ms");

		expect(Date.now() - startedAt).toBeLessThan(500);
	});
});
