import type { CallerIdentity } from "../../src/auth/caller-identity.ts";

export const authorizedIdentity: CallerIdentity = {
	userId: "authorized-user",
	email: "authorized@example.com",
};

export const unauthorizedIdentity: CallerIdentity = {
	userId: "unauthorized-user",
	email: "unauthorized@example.com",
};

export const createRestrictedReaderEmails = (): Set<string> =>
	new Set([authorizedIdentity.email]);
