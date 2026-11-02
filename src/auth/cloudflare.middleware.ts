import type { Request, Response, NextFunction } from "express";
import type { AppConfig } from "../config/env.ts";
import { createCloudflareVerifier } from "./cloudflare.verifier.ts";

export function createAuthMiddleware(config: AppConfig) {
	const verifyAccessJwt = createCloudflareVerifier(config);

	return async (req: Request, res: Response, next: NextFunction) => {
		const token = req.get("cf-access-jwt-assertion");

		if (!token) {
			res.status(403).send("Missing required CF Access JWT");
			return;
		}

		let identity;
		try {
			identity = await verifyAccessJwt(token);
		} catch {
			res.status(403).send("Invalid CF Access JWT");
			return;
		}

		next();
	};
}
