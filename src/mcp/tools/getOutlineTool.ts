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
				"Read an entire note by its path relative to the vault, maximum note size supported is 65,536 bytes",
			inputSchema: z.object({
				path: z
					.string()
					.describe(
						"The path of the note to read relative to the vault",
					),
			}),
		},
		async ({ path }) => {
			const outline = await vaultService.getOutline(path);
			return {
				content: [{ type: "text", text: JSON.stringify(outline) }],
			};
		},
	);
}
