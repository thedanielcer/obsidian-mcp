import { createMcpExpressApp } from "@modelcontextprotocol/express";
import type { Logger } from "pino";
import type { AppConfig } from "./config/env.ts";
import { healthHandler } from "./http/health.route.ts";
import { createMcpHttpHandler } from "./mcp/http-handler.ts";
import { createAuthMiddleware } from "./auth/cloudflare.middleware.ts";
import { VaultService } from "./vault/vault.service.ts";

export function createApp(config: AppConfig, logger: Logger) {
	const app = createMcpExpressApp({
		host: config.host,
		allowedHosts: config.allowedHosts,
	});

	const vaultService = new VaultService(
		config.vaultDir,
		logger.child({ source: "VaultService" }),
	);

	const mcpHttpHandler = createMcpHttpHandler(vaultService);
	const authMiddleware = createAuthMiddleware(config);

	app.get("/health", healthHandler);

	if (config.nodeEnv === "development") {
		app.all("/mcp", mcpHttpHandler);
	} else {
		app.all("/mcp", authMiddleware, mcpHttpHandler);
	}

	return app;
}
