import type { RequestHandler } from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpServer } from "./create-server.ts";
import type { CallerIdentity } from "../auth/caller-identity.ts";

export function createMcpHttpHandler(): RequestHandler {
	return (req, res, next) => {
		const identity: CallerIdentity = res.locals.identity;

		const handler = createMcpHandler(() => createMcpServer(identity));

		const nodeHandler = toNodeHandler(handler);

		nodeHandler(req, res, req.body).catch(next);
	};
}
