import { createReadStream, promises } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

/** Stage a complete replacement beside the original, then commit with rename. */
export async function writeNoteAtomically(
	notePath: string,
	content: string,
	expectedVersion: string,
	mode: "replace" | "prepend" = "replace",
): Promise<void> {
	const originalStats = await promises.stat(notePath, { bigint: true });
	const temporaryPath = join(
		dirname(notePath),
		`.obsidian-mcp-${randomUUID()}.tmp`,
	);
	const temporaryFile = await promises.open(temporaryPath, "wx", 0o600);

	async function* replacement() {
		yield content;
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(notePath, {
			highWaterMark: 64 * 1024,
		})) {
			hash.update(chunk);
			if (mode === "prepend") yield chunk;
		}
		if (hash.digest("hex") !== expectedVersion) {
			throw new Error(
				"VERSION_CONFLICT: The note has changed; read it again before editing",
			);
		}
	}

	try {
		await pipeline(replacement(), temporaryFile.createWriteStream());
		await promises.chmod(
			temporaryPath,
			Number(originalStats.mode & 0o777n),
		);
		const currentStats = await promises.stat(notePath, { bigint: true });
		if (
			currentStats.dev !== originalStats.dev ||
			currentStats.ino !== originalStats.ino ||
			currentStats.size !== originalStats.size ||
			currentStats.mtimeNs !== originalStats.mtimeNs ||
			currentStats.ctimeNs !== originalStats.ctimeNs
		) {
			throw new Error(
				"VERSION_CONFLICT: The note changed during the edit; read it again before editing",
			);
		}
		// External writers can still race between the metadata check and rename.
		await promises.rename(temporaryPath, notePath);
	} finally {
		try {
			await temporaryFile.close();
		} finally {
			await promises.rm(temporaryPath, { force: true });
		}
	}
}
