import type { RequestHandler } from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpServer } from "./create-server.ts";

export function createMcpHttpHandler(): RequestHandler {
	const handler = createMcpHandler(createMcpServer);
	const nodeHandler = toNodeHandler(handler);

	return (req, res, next) => {
		nodeHandler(req, res, req.body).catch(next);
	};
}
