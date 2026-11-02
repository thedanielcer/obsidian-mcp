import { loadEnvFile } from "node:process";
import * as z from "zod";

const appConfigSchema = z.object({
	host: z.string().trim().min(1).default("127.0.0.1"),
	port: z.coerce.number().int().min(1).max(65535).default(3000),
	teamDomain: z
		.string()
		.trim()
		.pipe(z.url({ protocol: /^https$/ })),
	policyAud: z.string().trim().min(1),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	loadEnvFile(".env");
    
	return appConfigSchema.parse({
		host: env.HOST,
		port: env.PORT,
		teamDomain: env.TEAM_DOMAIN,
		policyAud: env.POLICY_AUD,
	});
}
