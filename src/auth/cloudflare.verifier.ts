import { createRemoteJWKSet, jwtVerify } from "jose";
import {
	callerIdentitySchema,
	type CallerIdentity,
} from "./caller-identity.ts";

interface CloudflareConfig {
	teamDomain: string;
	policyAud: string;
}

export function createCloudflareVerifier(
	config: CloudflareConfig,
): (token: string) => Promise<CallerIdentity> {
	const JWKS = createRemoteJWKSet(
		new URL("cdn-cgi/access/certs", config.teamDomain),
	);

	return async function verifyAccessJwt(token: string) {
		const { payload } = await jwtVerify(token, JWKS, {
			issuer: config.teamDomain,
			audience: config.policyAud,
		});

		return callerIdentitySchema.parse({
			userId: payload.sub,
			email: payload.email,
		});
	};
}
