import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemoryTransport,
	LATEST_PROTOCOL_VERSION,
	type JSONRPCMessage,
	type McpServer,
} from "@modelcontextprotocol/server";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallerIdentity } from "../../src/auth/caller-identity.ts";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";
import { createMcpServer } from "../../src/mcp/create-server.ts";
import { VaultService } from "../../src/vault/vault.service.ts";
import {
	authorizedIdentity,
	createRestrictedReaderEmails,
	unauthorizedIdentity,
} from "../fixtures/identities.ts";

async function connect(server: McpServer) {
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await clientTransport.start();
	let nextId = 0;
	async function request(
		method: string,
		params: Record<string, unknown> = {},
	) {
		const id = ++nextId;
		const response = new Promise<JSONRPCMessage>((resolve) => {
			clientTransport.onmessage = (message) => {
				if ("id" in message && message.id === id) resolve(message);
			};
		});
		await clientTransport.send({ jsonrpc: "2.0", id, method, params });
		const message = await response;
		if ("error" in message) throw new Error(message.error.message);
		if (!("result" in message)) throw new Error("Expected an MCP response");
		return message.result;
	}
	await request("initialize", {
		protocolVersion: LATEST_PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "tool-registration-tests", version: "1.0.0" },
	});
	await clientTransport.send({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	});
	return {
		request,
		callTool: (name: string, args: Record<string, unknown>) =>
			request("tools/call", { name, arguments: args }),
	};
}

describe("MCP vault tool registrations", () => {
	let testDir: string;
	let service: VaultService;
	let servers: McpServer[];

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "obsidian-mcp-tools-"));
		const vaultDir = join(testDir, "vault");
		await mkdir(vaultDir);
		const restrictionsPath = join(testDir, "restrictions.json");
		await writeFile(restrictionsPath, "[]");
		await writeFile(
			join(vaultDir, "public.md"),
			"# Public\nOriginal content\n",
		);
		await writeFile(
			join(vaultDir, "private.md"),
			"---\nrestricted: true\n---\nSecret\n",
		);
		const logger = pino({ level: "silent" });
		service = new VaultService(
			logger,
			vaultDir,
			new RestrictionsService(
				logger,
				restrictionsPath,
				createRestrictedReaderEmails(),
				vaultDir,
			),
		);
		servers = [];
	});

	afterEach(async () => {
		await Promise.all(servers.map((server) => server.close()));
		await rm(testDir, { recursive: true, force: true });
	});

	async function session(identity: CallerIdentity) {
		const server = createMcpServer(service, identity);
		servers.push(server);
		return connect(server);
	}

	it("advertises every vault tool with descriptions and no caller-supplied identity", async () => {
		const client = await session(unauthorizedIdentity);
		const result = await client.request("tools/list");
		const tools = result.tools as {
			name: string;
			description: string;
			inputSchema: {
				properties: Record<string, { description: string }>;
			};
		}[];
		expect(tools.map((tool) => tool.name).sort()).toEqual(
			[
				"appendToNote",
				"beautifyNote",
				"createNote",
				"getNotePathByNoteName",
				"getNotes",
				"getOutline",
				"greet",
				"readNote",
				"readNoteLines",
				"replaceNote",
				"replaceNoteLines",
				"searchNotes",
			].sort(),
		);
		for (const tool of tools) {
			expect(tool.description).toBeTruthy();
			expect(tool.inputSchema.properties).not.toHaveProperty("identity");
			for (const argument of Object.values(tool.inputSchema.properties)) {
				expect(argument.description).toBeTruthy();
			}
		}
	});

	it("keeps captured identities isolated across sessions and ignores spoofed identity arguments", async () => {
		const authorized = await session(authorizedIdentity);
		const unauthorized = await session(unauthorizedIdentity);
		const allowed = await authorized.callTool("readNote", {
			path: "private.md",
		});
		expect(allowed.isError).not.toBe(true);
		expect(JSON.stringify(allowed.content)).toContain("Secret");
		const denied = await unauthorized.callTool("readNote", {
			path: "private.md",
			identity: authorizedIdentity,
		});
		expect(denied.isError).toBe(true);
		expect(JSON.stringify(denied.content)).not.toContain("Secret");
		const listed = await unauthorized.callTool("getNotes", {});
		expect(JSON.stringify(listed.content)).toContain("public.md");
		expect(JSON.stringify(listed.content)).not.toContain("private.md");
		const greeting = await unauthorized.callTool("greet", {
			name: "Reader",
		});
		expect(JSON.stringify(greeting.content)).toContain(
			unauthorizedIdentity.email,
		);
	});

	it("returns a usable note version and rejects stale edits through MCP", async () => {
		const client = await session(unauthorizedIdentity);
		const read = await client.callTool("readNote", { path: "public.md" });
		const content = read.content as { type: string; text: string }[];
		const note = JSON.parse(content[0]!.text);
		expect(note.content).toBe("# Public\nOriginal content\n");
		expect(note.version).toMatch(/^[a-f0-9]{64}$/);
		const edit = await client.callTool("replaceNoteLines", {
			path: "public.md",
			start: 2,
			end: 2,
			content: "Updated content",
			expectedVersion: note.version,
		});
		expect(edit).toMatchObject({
			content: [{ type: "text", text: '{"ok":true}' }],
		});
		const staleEdit = await client.callTool("appendToNote", {
			path: "public.md",
			content: "Stale edit",
			expectedVersion: note.version,
		});
		expect(staleEdit.isError).toBe(true);
		expect(JSON.stringify(staleEdit.content)).toContain("VERSION_CONFLICT");
		const lines = await client.callTool("readNoteLines", {
			path: "public.md",
			startLine: 2,
			endLine: 2,
		});
		expect(JSON.stringify(lines.content)).toContain("Updated content");
		expect(JSON.stringify(lines.content)).not.toContain("Stale edit");
	});
});
