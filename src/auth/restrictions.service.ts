import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, basename, resolve, win32 } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { CallerIdentity } from "./caller-identity.ts";
import {
	assertWithinVault,
	isWithinVault,
	resolveNotePath,
} from "../vault/vault-paths.ts";

// Retain restrictions for paths that do not exist yet, resolving existing ancestors.
async function canonicalRestriction(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ENOENT"
		)
			throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(await canonicalRestriction(parent), basename(path));
	}
}

export class RestrictionsService {
	constructor(
		private readonly logger: Logger,
		private readonly restrictedNotesPathsJson: string,
		private readonly canReadRestrictedNotes: Set<string>,
		private readonly vaultDir: string,
	) {
		this.vaultDir = resolve(vaultDir);
	}

	public async isRestricted(notePath: string): Promise<boolean> {
		const stream = createReadStream(notePath, {
			encoding: "utf8",
			highWaterMark: 5 * 1024,
		});

		let remainder = "";
		let isInsideProperties = false;
		const hasRestrictedProperty =
			/^[ \t]*(?:restricted|"restricted")[ \t]*:[ \t]*(?:true|"true"|'true')[ \t]*(?:#.*)?$/i;
		let i = 0;
		for await (const chunk of stream) {
			const text = remainder + chunk;
			const lines = text.split(/\r?\n/);

			remainder = lines.pop() ?? "";
			if (i === 0 && lines[0] !== undefined)
				lines[0] = lines[0].replace(/^\uFEFF/, "");
			if (lines[0] !== "---" && i === 0 && !isInsideProperties)
				return false;

			if (lines[0] === "---" || isInsideProperties) {
				!isInsideProperties && lines.shift(); // Shift elements of the array to the left is not inside properties block
				isInsideProperties = true;
				for (const line of lines) {
					if (line === "---") return false;
					if (hasRestrictedProperty.test(line) && isInsideProperties)
						return true;
				}
			}
			i++;
		}
		return false;
	}

	public async filterRestrictedNotes(
		notePaths: string[],
		identity: CallerIdentity,
	): Promise<string[]> {
		if (this.canReadRestrictedNotes.has(identity.email)) return notePaths;
		const schema = z.array(z.string().min(1));

		const fileContents = await readFile(
			this.restrictedNotesPathsJson,
			"utf8",
		);

		const vaultPath = await realpath(this.vaultDir);
		const restrictedPaths: string[] = [];
		for (const entry of schema.parse(JSON.parse(fileContents))) {
			const normalized = entry.replace(/\\/g, "/");
			if (
				!isAbsolute(normalized) &&
				(win32.isAbsolute(entry) || /^[a-z]:/i.test(entry))
			) {
				throw new Error(
					"Absolute restriction paths must use the server's filesystem format",
				);
			}
			const path = isAbsolute(normalized)
				? resolve(normalized)
				: resolveNotePath(vaultPath, normalized);
			const canonical = await canonicalRestriction(path);
			assertWithinVault(vaultPath, canonical);
			restrictedPaths.push(path, canonical);
		}

		const allowed: string[] = [];
		for (const path of notePaths) {
			const absolute = resolve(path);
			const canonical = await realpath(absolute);
			if (!isWithinVault(vaultPath, canonical)) continue;
			// Check both the discovered path and its target so aliases cannot bypass a restriction.
			if (
				restrictedPaths.some(
					(restricted) =>
						isWithinVault(restricted, absolute) ||
						isWithinVault(restricted, canonical),
				)
			)
				continue;
			if (!(await this.isRestricted(canonical))) allowed.push(path);
		}
		return allowed;
	}
}
