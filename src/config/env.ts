import { loadEnvFile } from "node:process";
import * as z from "zod";

const appConfigSchema = z.object({
	nodeEnv: z
		.enum(["development", "production", "test"])
		.default("production"),
	logLevel: z
		.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
		.default("info"),
	host: z.string().trim().min(1).default("0.0.0.0"),
	port: z.coerce.number().int().min(1).max(65535).default(3000),
	teamDomain: z
		.string()
		.trim()
		.pipe(z.url({ protocol: /^https$/ })),
	policyAud: z.string().trim().min(1),
	allowedHosts: z
		.string()
		.transform((value) =>
			value.split(",").map((hostname) => hostname.trim().toLowerCase()),
		)
		.pipe(z.array(z.hostname()).min(1)),
	vaultDir: z.string().trim().default("./vault"),
	restrictedNotesJson: z.string().trim(),
	canReadRestrictedNotes: z
		.string()
		.transform((value) =>
			value.split(",").map((allowed) => allowed.trim().toLowerCase()),
		),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function loadConfig(env?: NodeJS.ProcessEnv): AppConfig {
	if (env === undefined) {
		try {
			loadEnvFile(".env");
		} catch (error) {
			const isMissingEnvFile =
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT";
			if (!isMissingEnvFile) {
				throw error;
			}
		}

		env = process.env;
	}

	return appConfigSchema.parse({
		nodeEnv: env.NODE_ENV,
		logLevel: env.LOG_LEVEL,
		host: env.HOST,
		port: env.PORT,
		teamDomain: env.TEAM_DOMAIN,
		policyAud: env.POLICY_AUD,
		allowedHosts: env.ALLOWED_HOSTS,
		vaultDir: env.VAULT_DIR,
		restrictedNotesPaths: env.RESTRICTED_NOTES_JSON,
		canReadRestrictedNotes: env.CAN_READ_RESTRICTED_NOTES,
	});
}
