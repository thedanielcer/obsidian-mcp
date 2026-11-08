import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerIdentity } from "../../auth/caller-identity.ts";
import type { VaultService } from "../../vault/vault.service.ts";

export function registerReplaceNoteLinesTool(
	server: McpServer,
	vaultService: VaultService,
	identity: CallerIdentity,
) {
	server.registerTool(
		"replaceNoteLines",
		{
			description:
				"Replace an inclusive, 1-based line range in an accessible existing note, preserving its newline style. Empty content deletes the range. Requires the version from readNote or readNoteLines; on VERSION_CONFLICT, read again before editing. Returns { ok: true } on success.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.describe(
						"The path of the note to edit relative to the vault",
					),
				start: z
					.number()
					.int()
					.min(1)
					.max(Number.MAX_SAFE_INTEGER)
					.describe(
						"The first line to replace, inclusive and 1-based",
					),
				end: z
					.number()
					.int()
					.min(1)
					.max(Number.MAX_SAFE_INTEGER)
					.describe(
						"The last line to replace, inclusive and 1-based; must be greater than or equal to start and within the note",
					),
				content: z
					.string()
					.describe(
						"The replacement Markdown content for the selected lines; an empty string deletes them",
					),
				expectedVersion: z
					.string()
					.regex(/^[a-f0-9]{64}$/i)
					.describe(
						"The SHA-256 version of the entire note returned by the most recent readNote or readNoteLines call",
					),
			}),
		},
		async ({ path, start, end, content, expectedVersion }) => {
			const result = await vaultService.replaceNoteLines(
				path,
				start,
				end,
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
