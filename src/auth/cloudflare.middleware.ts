import type { NextFunction } from "express";
import type { AppConfig } from "../config/env.ts";
import { createCloudflareVerifier } from "./cloudflare.verifier.ts";

export function createAuthMiddleware(config: AppConfig) {
	const verifyAccessJwt = createCloudflareVerifier(config);

	return async (req: Request, res: Response, next: NextFunction) => {
		const token = req.headers.get("cf-access-jwt-assertion");

		if (!token) {
			return new Response("Missing required CF Access JWT", {
				status: 403,
				headers: { "Content-Type": "text/plain" },
			});
		}

		let identity;
		try {
			identity = verifyAccessJwt(token);
		} catch {
			return new Response("Invalid CF Access JWT", {
				status: 403,
				headers: { "Content-Type": "text/plain" },
			});
		}

		next();
	};
}
