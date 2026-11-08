import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerIdentity } from "../../auth/caller-identity.ts";
import type { VaultService } from "../../vault/vault.service.ts";

export function registerReadNoteLinesTool(
	server: McpServer,
	vaultService: VaultService,
	identity: CallerIdentity,
) {
	server.registerTool(
		"readNoteLines",
		{
			description:
				"Read an inclusive, 1-based line range from an accessible note, including notes too large for readNote. Returns the path, requested range, content, and SHA-256 version of the entire note for subsequent edits.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.describe(
						"The path of the note to read relative to the vault",
					),
				startLine: z
					.number()
					.int()
					.min(1)
					.max(Number.MAX_SAFE_INTEGER)
					.describe("The first line to read, inclusive and 1-based"),
				endLine: z
					.number()
					.int()
					.min(1)
					.max(Number.MAX_SAFE_INTEGER)
					.describe(
						"The last line to read, inclusive and 1-based; must be greater than or equal to startLine",
					),
			}),
		},
		async ({ path, startLine, endLine }) => {
			const result = await vaultService.readNoteLines(
				path,
				startLine,
				endLine,
				identity,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
			};
		},
	);
}
