import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerIdentity } from "../../auth/caller-identity.ts";
import type { VaultService } from "../../vault/vault.service.ts";

export function registerBeautifyNoteTool(
	server: McpServer,
	vaultService: VaultService,
	identity: CallerIdentity,
) {
	server.registerTool(
		"beautifyNote",
		{
			description:
				"Prepend supplied content to an accessible existing note without adding a separator. Requires the version from readNote or readNoteLines; on VERSION_CONFLICT, read again before editing. Returns { ok: true } on success.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.describe(
						"The path of the note to prepend to relative to the vault",
					),
				content: z
					.string()
					.describe(
						"The Markdown content to insert before the existing content; include any required trailing newline or separator",
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
			const result = await vaultService.beautifyNote(
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
