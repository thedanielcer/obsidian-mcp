import { McpServer } from "@modelcontextprotocol/server";
import { registerGreetTool } from "./tools/greetTool.ts";
import type { CallerIdentity } from "../auth/caller-identity.ts";
import type { VaultService } from "../vault/vault.service.ts";
import { registerGetNotesTool } from "./tools/getNotesTool.ts";
import { registerReadNoteTool } from "./tools/readNoteTool.ts";
import { registerGetOutlineTool } from "./tools/getOutlineTool.ts";

export function createMcpServer(
	vaultService: VaultService,
	identity: CallerIdentity,
): McpServer {
	const server = new McpServer({ name: "Obsidian MCP", version: "1.0.0" });

	registerGreetTool(server, identity);
	registerGetNotesTool(server, vaultService, identity);
	registerReadNoteTool(server, vaultService, identity);
	registerGetOutlineTool(server, vaultService, identity);

	return server;
}
