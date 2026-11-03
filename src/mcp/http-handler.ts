import type { RequestHandler } from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpServer } from "./create-server.ts";
import type { CallerIdentity } from "../auth/caller-identity.ts";
import type { VaultService } from "../vault/vault.service.ts";

export function createMcpHttpHandler(
	vaultService: VaultService,
): RequestHandler {
	return (req, res, next) => {
		const identity: CallerIdentity = res.locals.identity;

		const handler = createMcpHandler(() =>
			createMcpServer(vaultService, identity),
		);

		const nodeHandler = toNodeHandler(handler);

		nodeHandler(req, res, req.body).catch(next);
	};
}
