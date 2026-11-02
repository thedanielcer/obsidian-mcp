import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

function greetTool(name: string): string {
	return `Hello, ${name}! Welcome to the Obsidian MCP server.`;
}

export function registerGreetTool(server: McpServer) {
	server.registerTool(
		"greet",
		{
			description: "Dummy tool that greets the caller",
			inputSchema: z.object({
				name: z.string().describe("The name to use in the greeting"),
			}),
		},
		({ name }) => ({
			content: [{ type: "text", text: greetTool(name) }],
		}),
	);
}

export const text: string = "asdfasdf";
