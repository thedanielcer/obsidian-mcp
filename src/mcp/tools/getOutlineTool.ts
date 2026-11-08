import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { CallerIdentity } from "../../auth/caller-identity.ts";
import type { VaultService } from "../../vault/vault.service.ts";

export function registerGetOutlineTool(
	server: McpServer,
	vaultService: VaultService,
	identity: CallerIdentity,
) {
	server.registerTool(
		"getOutline",
		{
			description:
				"Get the heading hierarchy of an accessible Markdown note, including heading text, 1-based line numbers, and nested headings.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.describe(
						"The path of the note to outline relative to the vault",
					),
			}),
		},
		async ({ path }) => {
			const outline = await vaultService.getOutline(path, identity);
			return {
				content: [{ type: "text", text: JSON.stringify(outline) }],
			};
		},
	);
}
