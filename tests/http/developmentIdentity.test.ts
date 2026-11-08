import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import pino from "pino";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import type { AppConfig } from "../../src/config/env.ts";

let root: string;
let config: AppConfig;
let server: Server | undefined;
const logger = pino({ level: "silent" });

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "development-identity-"));
	await writeFile(join(root, "restrictions.json"), "[]");
	await writeFile(join(root, "public.md"), "# Public\n");
	await writeFile(
		join(root, "private.md"),
		"---\nrestricted: true\n---\nSecret\n",
	);
	config = {
		nodeEnv: "development",
		logLevel: "silent",
		host: "127.0.0.1",
		port: 3000,
		allowedHosts: ["127.0.0.1"],
		teamDomain: "https://example.cloudflareaccess.com",
		policyAud: "test-audience",
		vaultDir: root,
		restrictedNotesJson: join(root, "restrictions.json"),
		canReadRestrictedNotes: ["admin@example.com"],
	};
});
afterEach(async () => {
	if (server) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server!.close((error) => (error ? reject(error) : resolve())),
		);
		server = undefined;
	}
	await rm(root, { recursive: true, force: true });
});

async function start() {
	server = createApp(config, logger).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server!.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Expected TCP address");
	return `http://127.0.0.1:${address.port}/mcp`;
}

async function request(url: string, method: string, params: object) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const body = await response.text();
	expect(response.status).toBe(200);
	const data = body.split("\n").find((line) => line.startsWith("data: "));
	return JSON.parse(data ? data.slice(6) : body).result;
}

it("initializes over HTTP and supplies a usable non-admin development identity", async () => {
	const url = await start();
	expect(
		await request(url, "initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		}),
	).toHaveProperty("serverInfo");
	const greet = await request(url, "tools/call", {
		name: "greet",
		arguments: { name: "Daniel" },
	});
	expect(greet.isError).not.toBe(true);
	expect(JSON.stringify(greet.content)).toContain(
		"development@example.invalid",
	);
	const read = await request(url, "tools/call", {
		name: "readNote",
		arguments: { path: "public.md" },
	});
	expect(read.isError).not.toBe(true);
	expect(JSON.stringify(read.content)).toContain("Public");
	const denied = await request(url, "tools/call", {
		name: "readNote",
		arguments: { path: "private.md" },
	});
	expect(denied.isError).toBe(true);
	expect(JSON.stringify(denied.content)).not.toContain("Secret");
});

it.each(["0.0.0.0", "::", "192.168.100.132"])(
	"rejects unauthenticated development binding to %s",
	(host) => {
		expect(() => createApp({ ...config, host }, logger)).toThrow(
			"loopback HOST",
		);
	},
);

it.each(["production", "test"] as const)(
	"still requires authentication in %s",
	async (nodeEnv) => {
		config.nodeEnv = nodeEnv;
		const url = await start();
		for (const headers of [{}, { "cf-access-jwt-assertion": "invalid" }]) {
			const response = await fetch(url, { method: "POST", headers });
			expect(response.status).toBe(403);
			await response.text();
		}
	},
);
