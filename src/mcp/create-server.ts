import { McpServer } from "@modelcontextprotocol/server";
import { registerGreetTool } from "./tools/greetTool.ts";
import type { JWTPayload } from "jose";

export function createMcpServer(identity: JWTPayload): McpServer {
	const server = new McpServer({ name: "Obsidian MCP", version: "1.0.0" });

	registerGreetTool(server, identity);

	return server;
}
