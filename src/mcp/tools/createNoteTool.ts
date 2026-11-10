import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { VaultService } from "../../vault/vault.service.ts";
import type { CallerIdentity } from "../../auth/caller-identity.ts";

export function registerCreateNoteTool(
	server: McpServer,
	vaultService: VaultService,
	identity: CallerIdentity,
) {
	server.registerTool(
		"createNote",
		{
			description:
				"Create a new note with the supplied content. The parent directory must exist; an existing note will not be overwritten. Returns { ok: true } on success.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.describe(
						"The new note's path relative to the vault, including the .md extension",
					),
				content: z
					.string()
					.describe(
						"The complete Markdown content of the new note; may be empty",
					),
			}),
		},
		async ({ path, content }) => {
			const result = await vaultService.createNote(
				path,
				content,
				identity,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
			};
		},
	);
}
