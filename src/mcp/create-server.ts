import { McpServer } from "@modelcontextprotocol/server";
import { registerGreetTool } from "./tools/greetTool.ts";
import type { CallerIdentity } from "../auth/caller-identity.ts";
import type { VaultService } from "../vault/vault.service.ts";
import { registerGetNotesTool } from "./tools/getNotesTool.ts";
import { registerReadNoteTool } from "./tools/readNoteTool.ts";
import { registerGetOutlineTool } from "./tools/getOutlineTool.ts";
import { registerCreateNoteTool } from "./tools/createNoteTool.ts";
import { registerGetNotePathByNoteNameTool } from "./tools/getNotePathByNoteNameTool.ts";
import { registerReadNoteLinesTool } from "./tools/readNoteLinesTool.ts";
import { registerSearchNotesTool } from "./tools/searchNotesTool.ts";
import { registerReplaceNoteTool } from "./tools/replaceNoteTool.ts";
import { registerReplaceNoteLinesTool } from "./tools/replaceNoteLinesTool.ts";
import { registerAppendToNoteTool } from "./tools/appendToNoteTool.ts";
import { registerBeautifyNoteTool } from "./tools/beautifyNoteTool.ts";

export function createMcpServer(
	vaultService: VaultService,
	identity: CallerIdentity,
): McpServer {
	const server = new McpServer({ name: "Obsidian MCP", version: "1.0.0" });

	registerGreetTool(server, identity);
	registerCreateNoteTool(server, vaultService);
	registerGetNotesTool(server, vaultService, identity);
	registerGetNotePathByNoteNameTool(server, vaultService, identity);
	registerReadNoteTool(server, vaultService, identity);
	registerReadNoteLinesTool(server, vaultService, identity);
	registerGetOutlineTool(server, vaultService, identity);
	registerSearchNotesTool(server, vaultService, identity);
	registerReplaceNoteTool(server, vaultService, identity);
	registerReplaceNoteLinesTool(server, vaultService, identity);
	registerAppendToNoteTool(server, vaultService, identity);
	registerBeautifyNoteTool(server, vaultService, identity);

	return server;
}
