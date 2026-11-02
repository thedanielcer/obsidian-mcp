import * as z from "zod";

export const callerIdentitySchema = z.object({
	userId: z.string().trim().min(1),
	email: z.email(),
});

export type CallerIdentity = z.infer<typeof callerIdentitySchema>;
