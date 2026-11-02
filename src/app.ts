import { createMcpExpressApp } from "@modelcontextprotocol/express";
import type { AppConfig } from "./config/env.ts";
import { healthHandler } from "./http/health.route.ts";
import { createMcpHttpHandler } from "./mcp/http-handler.ts";
import { createAuthMiddleware } from "./auth/cloudflare.middleware.ts";

export function createApp(config: AppConfig) {
	const app = createMcpExpressApp({
		host: config.host,
	});

	const mcpHttpHandler = createMcpHttpHandler();
	const authMiddleware = createAuthMiddleware(config);

	app.get("/health", healthHandler);

	app.all("/mcp", authMiddleware, mcpHttpHandler);

	return app;
}
