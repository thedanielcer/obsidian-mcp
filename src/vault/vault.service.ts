import { createReadStream, promises } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { buffer } from "node:stream/consumers";

export class VaultService {
	private readonly vaultDir: string;
	private readonly readNoteMaxSize: number = 64 * 1024;

	constructor(vaultDir: string) {
		this.vaultDir = vaultDir;
	}

	public async getNotes(
		page: number = 1,
		pageSize: number = 50,
	): Promise<string[]> {
		if (
			!Number.isSafeInteger(page) ||
			page < 1 ||
			!Number.isSafeInteger(pageSize) ||
			pageSize < 1
		) {
			throw new RangeError("page and pageSize must be positive integers");
		}

		const entries = await promises.readdir(this.vaultDir, {
			recursive: true,
			withFileTypes: true,
		});

		const paths = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) =>
				relative(this.vaultDir, join(entry.parentPath, entry.name)),
			)
			.sort();

		const start = (page - 1) * pageSize;
		return paths.slice(start, start + pageSize);
	}

	public async readNote(path: string): Promise<string> {
		if (
			!Number.isSafeInteger(this.readNoteMaxSize) ||
			this.readNoteMaxSize < 1
		) {
			throw new RangeError(
				"this.readNoteMaxSize must be a positive integer",
			);
		}

		const vaultPath = await promises.realpath(this.vaultDir);

		const notePath = await promises.realpath(join(vaultPath, path));

		const relativePath = relative(vaultPath, notePath);
		if (
			relativePath === ".." ||
			relativePath.startsWith(`..${sep}`) ||
			isAbsolute(relativePath)
		) {
			throw new Error("Note path must be inside the vault");
		}

		const fileStats = await promises.stat(notePath);
		if (fileStats.size > this.readNoteMaxSize) {
			throw new Error(
				`NOTE_TOO_LARGE: This note is ${fileStats.size} bytes` +
					`\nreadNote supports notes up to ${this.readNoteMaxSize} bytes` +
					"\nNo note content was returned",
			);
		}

		// end is inclusive: the extra byte tells us whether the note exceeds the limit.
		const contents = await buffer(
			createReadStream(notePath, { start: 0, end: this.readNoteMaxSize }),
		);
		if (contents.length > this.readNoteMaxSize) {
			throw new Error(
				`NOTE_TOO_LARGE: This note is ${contents.length} bytes` +
					`\nreadNote supports notes up to ${this.readNoteMaxSize} bytes` +
					"\nNo note content was returned",
			);
		}

		return contents.toString("utf8");
	}
}
