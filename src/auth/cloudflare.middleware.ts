import type { Request, Response, NextFunction } from "express";
import type { AppConfig } from "../config/env.ts";
import { createCloudflareVerifier } from "./cloudflare.verifier.ts";
import type { CallerIdentity } from "./caller-identity.ts";

export function createAuthMiddleware(config: AppConfig) {
	const verifyAccessJwt = createCloudflareVerifier(config);

	return async (req: Request, res: Response, next: NextFunction) => {
		const token = req.get("cf-access-jwt-assertion");

		if (!token) {
			res.status(403).send("Missing required CF Access JWT");
			return;
		}

		try {
			const identity: CallerIdentity = await verifyAccessJwt(token);
			res.locals.identity = identity;
		} catch {
			res.status(403).send("Invalid CF Access JWT");
			return;
		}

		next();
	};
}
