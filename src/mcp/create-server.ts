import { McpServer } from "@modelcontextprotocol/server";
import { registerGreetTool } from "./tools/greetTool.ts";

export function createMcpServer() {
	const server = new McpServer({ name: "Obsidian MCP", version: "1.0.0" });

	registerGreetTool(server);

	return server;
}
