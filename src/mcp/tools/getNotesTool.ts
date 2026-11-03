import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerIdentity } from "../../auth/caller-identity.ts";
import type { VaultService } from "../../vault/vault.service.ts";

export function registerGetNotesTool(
	server: McpServer,
	vaultService: VaultService,
	identity: CallerIdentity,
) {
	server.registerTool(
		"getNotes",
		{
			description:
				"Tool to retrieve notes from the vault by path with pagination support",
			inputSchema: z.object({
				page: z.number().describe("The page number to retrieve"),
				pageSize: z
					.number()
					.describe("The number of notes to retrieve per page"),
			}),
		},
		async ({ page, pageSize }) => {
			const notes = await vaultService.getNotes(page, pageSize);
			return {
				content: [{ type: "text", text: JSON.stringify(notes) }],
			};
		},
	);
}
