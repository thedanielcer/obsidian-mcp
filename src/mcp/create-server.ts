import { McpServer } from "@modelcontextprotocol/server";
import { registerGreetTool } from "./tools/greetTool.ts";
import type { CallerIdentity } from "../auth/caller-identity.ts";
import type { VaultService } from "../vault/vault.service.ts";
import { registerGetNotesTool } from "./tools/getNotesTool.ts";

export function createMcpServer(
	vaultService: VaultService,
	identity: CallerIdentity,
): McpServer {
	const server = new McpServer({ name: "Obsidian MCP", version: "1.0.0" });

	registerGreetTool(server, identity);
	registerGetNotesTool(server, vaultService, identity);

	return server;
}
