import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerIdentity } from "../../auth/caller-identity.ts";
import type { VaultService } from "../../vault/vault.service.ts";

export function registerSearchNotesTool(
	server: McpServer,
	vaultService: VaultService,
	identity: CallerIdentity,
) {
	server.registerTool(
		"searchNotes",
		{
			description:
				"Search accessible Markdown note contents using literal text or a ripgrep regular expression. Returns matching lines with paths, 1-based line numbers, text, and pagination metadata, sorted by path.",
			inputSchema: z.object({
				query: z
					.string()
					.describe(
						"The literal text or ripgrep regular expression to search for",
					),
				regex: z
					.boolean()
					.default(false)
					.describe(
						"Whether query is a ripgrep regular expression instead of literal text",
					),
				caseSensitive: z
					.boolean()
					.default(false)
					.describe(
						"Whether the search should distinguish uppercase and lowercase letters",
					),
				skip: z
					.number()
					.int()
					.min(0)
					.max(Number.MAX_SAFE_INTEGER)
					.default(0)
					.describe(
						"The number of accessible matching lines to skip",
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(Number.MAX_SAFE_INTEGER)
					.default(50)
					.describe("The maximum number of matching lines to return"),
			}),
		},
		async ({ query, regex, caseSensitive, skip, limit }) => {
			const result = await vaultService.searchNotes(
				query,
				regex,
				caseSensitive,
				skip,
				limit,
				identity,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
			};
		},
	);
}
