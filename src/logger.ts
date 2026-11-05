import pino from "pino";
import type { AppConfig } from "./config/env.ts";

export function createLogger(config: Pick<AppConfig, "nodeEnv" | "logLevel">) {
	return pino({
		level: config.logLevel,
		redact: {
			paths: [
				"authorization",
				"headers.authorization",
				"req.headers.authorization",
				"headers.cookie",
				"req.headers.cookie",
				'headers["cf-access-jwt-assertion"]',
				'req.headers["cf-access-jwt-assertion"]',
			],
			censor: "[REDACTED]",
		},
		transport:
			config.nodeEnv === "development"
				? {
						target: "pino-pretty",
						options: {
							colorize: process.stdout.isTTY === true,
							translateTime: "SYS:standard",
						},
					}
				: undefined,
	});
}
