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
				skip: z
					.number()
					.int()
					.min(0)
					.max(Number.MAX_SAFE_INTEGER)
					.default(0)
					.describe("The number of accessible notes to skip"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(Number.MAX_SAFE_INTEGER)
					.default(50)
					.describe("The maximum number of notes to return"),
			}),
		},
		async ({ skip, limit }) => {
			const result = await vaultService.getNotes(skip, limit);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
			};
		},
	);
}
