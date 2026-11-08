import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerIdentity } from "../../auth/caller-identity.ts";
import type { VaultService } from "../../vault/vault.service.ts";

export function registerGetNotePathByNoteNameTool(
	server: McpServer,
	vaultService: VaultService,
	identity: CallerIdentity,
) {
	server.registerTool(
		"getNotePathByNoteName",
		{
			description:
				"Find accessible Markdown notes whose filenames match a name fragment. Returns sorted paths relative to the vault and pagination metadata.",
			inputSchema: z.object({
				noteName: z
					.string()
					.min(1)
					.describe(
						"The case-sensitive filename fragment to match without the .md extension; ripgrep glob syntax is supported",
					),
				skip: z
					.number()
					.int()
					.min(0)
					.max(Number.MAX_SAFE_INTEGER)
					.default(0)
					.describe(
						"The number of accessible matching note paths to skip",
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(Number.MAX_SAFE_INTEGER)
					.default(50)
					.describe(
						"The maximum number of matching note paths to return",
					),
			}),
		},
		async ({ noteName, skip, limit }) => {
			const result = await vaultService.getNotePathByNoteName(
				noteName,
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
