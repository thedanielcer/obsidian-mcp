import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import { z } from "zod";

export class RestrictionsService {
	constructor(
		private readonly logger: Logger,
		private readonly restrictedNotesPaths: string,
	) {}

	public async isRestricted(notePath: string): Promise<boolean> {
		const stream = createReadStream(notePath, {
			encoding: "utf8",
			highWaterMark: 5 * 1024,
		});

		let remainder = "";
		let isInsideProperties = false;
		const hasRestrictedProperty =
			/^[ \t]*restricted[ \t]*:[ \t]*(?:true|"true"|'true')[ \t]*(?:#.*)?$/i;
		let i = 0;
		for await (const chunk of stream) {
			const text = remainder + chunk;
			const lines = text.split(/\r?\n/);

			remainder = lines.pop() ?? "";
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

	public async filterRestrictedNotes(notePaths: string[]): Promise<string[]> {
		const schema = z.array(z.string());

		const fileContents = await readFile(this.restrictedNotesPaths, "utf8");

		const restrictedPathsSet = new Set(
			schema.parse(JSON.parse(fileContents)),
		);

		for (let i = notePaths.length - 1; i >= 0; i--) {
			const path = notePaths[i];
			if (!path) continue;
			if (
				restrictedPathsSet.has(path) ||
				(await this.isRestricted(path))
			) {
				notePaths.splice(i, 1);
			}
		}
		return notePaths;
	}
}
