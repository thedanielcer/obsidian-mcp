import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerIdentity } from "../../auth/caller-identity.ts";
import type { VaultService } from "../../vault/vault.service.ts";

export function registerReplaceNoteTool(
	server: McpServer,
	vaultService: VaultService,
	identity: CallerIdentity,
) {
	server.registerTool(
		"replaceNote",
		{
			description:
				"Replace the entire content of an accessible existing note. Requires the version from readNote or readNoteLines; on VERSION_CONFLICT, read the note again before editing. Returns { ok: true } on success.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.describe(
						"The path of the note to replace relative to the vault",
					),
				content: z
					.string()
					.describe(
						"The complete replacement Markdown content; an empty string clears the note",
					),
				expectedVersion: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.describe(
						"The lowercase SHA-256 version returned by the most recent readNote or readNoteLines call",
					),
			}),
		},
		async ({ path, content, expectedVersion }) => {
			const result = await vaultService.replaceNote(
				path,
				content,
				expectedVersion,
				identity,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
			};
		},
	);
}
