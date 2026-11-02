import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerIdentity } from "../../auth/caller-identity.ts";

function greetTool(name: string, identity: CallerIdentity): string {
	return (
		`Hello, ${name}! Welcome to the Obsidian MCP server.\n` +
		`You're authenticated as ${identity.email}.\n` +
		`Your user ID is ${identity.userId}.`
	);
}

export function registerGreetTool(server: McpServer, identity: CallerIdentity) {
	server.registerTool(
		"greet",
		{
			description: "Dummy tool that greets the caller",
			inputSchema: z.object({
				name: z.string().describe("The name to use in the greeting"),
			}),
		},
		({ name }) => ({
			content: [{ type: "text", text: greetTool(name, identity) }],
		}),
	);
}
