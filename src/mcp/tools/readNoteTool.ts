import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerIdentity } from "../../auth/caller-identity.ts";
import type { VaultService } from "../../vault/vault.service.ts";

export function registerReadNoteTool(
	server: McpServer,
	vaultService: VaultService,
	identity: CallerIdentity,
) {
	server.registerTool(
		"readNote",
		{
			description:
				"Read an accessible note up to 65,536 bytes. Returns its path, content, and SHA-256 version for subsequent edits. Use readNoteLines for larger notes.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.describe(
						"The path of the note to read relative to the vault",
					),
			}),
		},
		async ({ path }) => {
			const note = await vaultService.readNote(path, identity);
			return {
				content: [{ type: "text", text: JSON.stringify(note) }],
			};
		},
	);
}
