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
				"List accessible Markdown note paths relative to the vault in sorted order, with pagination metadata.",
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
			const result = await vaultService.getNotes(skip, limit, identity);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
			};
		},
	);
}
