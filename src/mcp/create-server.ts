import { McpServer } from "@modelcontextprotocol/server";
import { registerGreetTool } from "./tools/greetTool.ts";
import type { CallerIdentity } from "../auth/caller-identity.ts";

export function createMcpServer(identity: CallerIdentity): McpServer {
	const server = new McpServer({ name: "Obsidian MCP", version: "1.0.0" });

	registerGreetTool(server, identity);

	return server;
}
