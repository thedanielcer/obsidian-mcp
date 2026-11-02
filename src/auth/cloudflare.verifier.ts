import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

interface CloudflareConfig {
	teamDomain: string;
	policyAud: string;
}

export function createCloudflareVerifier(
	config: CloudflareConfig,
): (token: string) => Promise<JWTPayload> {
	const JWKS = createRemoteJWKSet(
		new URL("cdn-cgi/access/certs", config.teamDomain),
	);

	return async function verifyAccessJwt(token: string) {
		const { payload } = await jwtVerify(token, JWKS, {
			issuer: config.teamDomain,
			audience: config.policyAud,
		});

		return payload;
	};
}
