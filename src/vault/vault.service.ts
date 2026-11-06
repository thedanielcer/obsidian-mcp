import { createReadStream, promises } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { buffer } from "node:stream/consumers";
import type { Logger } from "pino";

enum HeadingLevels {
	firstLevel,
	secondLevel,
	thirdLevel,
	fourthLevel,
	fifthLevel,
	sixthLevel,
}

export type Outline = {
	name: string;
	start: number;
	// end: number;
	outline: Outline[];
};

export type GetOutlineResult = {
	notePath: string;
	outline: Outline[];
};

export class VaultService {
	private readonly vaultDir: string;
	private readonly readNoteMaxSize: number = 64 * 1024;

	constructor(
		vaultDir: string,
		private readonly logger: Logger,
	) {
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

		this.logger.debug(
			{ page, pageSize, skip: (page - 1) * pageSize },
			"Getting notes",
		);

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

		const notePath = await this.validatePath(path);

		if (!notePath) {
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

	public async getOutline(path: string): Promise<GetOutlineResult> {
		this.logger.debug({ path }, "Getting note outline");

		const notePath = await this.validatePath(path);
		if (!notePath) {
			this.logger.debug({ path }, "Rejected outline path outside vault");
			throw new Error("Note path must be inside the vault");
		}

		const stream = createReadStream(notePath, {
			encoding: "utf8",
			highWaterMark: 10 * 1024,
		});

		const outline: Outline[] = [];
		const finalOutline: GetOutlineResult = {
			notePath: notePath,
			outline: [],
		};

		let remainder = "";
		let lastMatchLevel = 0;
		let lineNumber = 0;
		let i = 0;
		let isInCodeBlock = false;

		let array: Outline[][] = [];

		const outlineFunciton = (match: RegExpExecArray | null) => {
			if (match && match[2] && match[1]) {
				const currentMatchLevel = match[1].length - 1;
				const previousMatchLevel = lastMatchLevel;
				if (i === 0) lastMatchLevel = 0;

				this.logger.debug(
					{
						lineNumber,
						headingText: match[2],
						headingLevel: currentMatchLevel + 1,
						previousHeadingLevel: previousMatchLevel + 1,
						effectivePreviousHeadingLevel: lastMatchLevel + 1,
						levelInitialized: Array.isArray(
							array[currentMatchLevel],
						),
					},
					"Matched outline heading",
				);

				if (lastMatchLevel > currentMatchLevel) {
					this.logger.debug(
						{
							fromHeadingLevel: lastMatchLevel + 1,
							toHeadingLevel: currentMatchLevel + 1,
							array,
						},
						"Making node",
					);

					const node = this.makeNode(array);
					if (node) {
						array = node;

						this.logger.debug(
							{
								nodeCreated: node !== undefined,
								// nodeHeading: node?.name,
								topLevelOutlineCount: outline.length,
								topLevelHeadings: outline.map(
									(heading) => heading.name,
								),
								node,
								array,
							},
							"Collapsed accumulated outline levels",
						);
					}
				}
				switch (currentMatchLevel) {
					case HeadingLevels.firstLevel:
						lastMatchLevel = HeadingLevels.firstLevel;
						if (!array[HeadingLevels.firstLevel])
							array[HeadingLevels.firstLevel] = [];
						array[HeadingLevels.firstLevel].push({
							name: match[2],
							start: lineNumber,
							outline: [],
						});
						break;
					case HeadingLevels.secondLevel:
						lastMatchLevel = HeadingLevels.secondLevel;
						if (!array[HeadingLevels.secondLevel])
							array[HeadingLevels.secondLevel] = [];
						array[HeadingLevels.secondLevel].push({
							name: match[2],
							start: lineNumber,
							outline: [],
						});
						break;
					case HeadingLevels.thirdLevel:
						lastMatchLevel = HeadingLevels.thirdLevel;
						if (!array[HeadingLevels.thirdLevel])
							array[HeadingLevels.thirdLevel] = [];
						array[HeadingLevels.thirdLevel].push({
							name: match[2],
							start: lineNumber,
							outline: [],
						});
						break;
					case HeadingLevels.fourthLevel:
						lastMatchLevel = HeadingLevels.fourthLevel;
						if (!array[HeadingLevels.fourthLevel])
							array[HeadingLevels.fourthLevel] = [];
						array[HeadingLevels.fourthLevel].push({
							name: match[2],
							start: lineNumber,
							outline: [],
						});
						break;
					case HeadingLevels.fifthLevel:
						lastMatchLevel = HeadingLevels.fifthLevel;
						if (!array[HeadingLevels.fifthLevel])
							array[HeadingLevels.fifthLevel] = [];
						array[HeadingLevels.fifthLevel].push({
							name: match[2],
							start: lineNumber,
							outline: [],
						});
					case HeadingLevels.sixthLevel:
						lastMatchLevel = HeadingLevels.sixthLevel;
						if (!array[HeadingLevels.sixthLevel])
							array[HeadingLevels.sixthLevel] = [];
						array[HeadingLevels.sixthLevel].push({
							name: match[2],
							start: lineNumber,
							outline: [],
						});
						break;
					default:
						break;
				}

				this.logger.debug(
					{
						headingText: match[2],
						headingLevel: currentMatchLevel + 1,
						array,
					},
					"Stored outline heading",
				);
			}
		};

		for await (const chunk of stream) {
			const text = remainder + chunk;
			const lines = text.split(/\r?\n/);
			this.logger.debug({ lines }, "Lines");

			// The last item might be only part of a line.
			remainder = lines.pop() ?? "";

			this.logger.debug(
				{
					chunkLength: chunk.length,
					completeLineCount: lines.length,
					remainderLength: remainder.length,
				},
				"Processing outline stream chunk",
			);

			for (const line of lines) {
				lineNumber += 1;
				this.logger.debug({ line }, "Line");
				const codeBlockMatch = /^[ \t]{0,3}`{3,}[^\r\n]*$/.exec(line);
				if (isInCodeBlock && !codeBlockMatch) {
					this.logger.debug("WE'RE IN A CODEBLOCK");
					continue;
				} else if (codeBlockMatch && !isInCodeBlock) {
					this.logger.debug(
						{ codeBlockMatch, isInCodeBlock },
						"ENTERING CODE BLOCK",
					);
					isInCodeBlock = true;
					continue;
				} else if (codeBlockMatch && isInCodeBlock) {
					this.logger.debug(
						{ codeBlockMatch, isInCodeBlock },
						"EXITING CODE BLOCK",
					);
					isInCodeBlock = false;
					continue;
				}
				const match = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
				outlineFunciton(match);

				i++;
			}
		}

		this.logger.debug({ remainder }, "Remainder");

		lineNumber += 1;
		const finalLineMatch = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(remainder);
		this.logger.debug({ finalLineMatch }, "Final line match");
		outlineFunciton(finalLineMatch);
		const node = this.makeNode(array);
		if (node) {
			array = node;

			this.logger.debug(
				{
					topLevelOutlineCount: outline.length,
					topLevelHeadings: outline.map((heading) => heading.name),
					node,
					array,
				},
				"Final collapse accumulated outline levels",
			);
		}

		this.logger.debug(
			{
				processedLineCount: lineNumber,
				remainderLength: remainder.length,
				finalLineIsHeading: finalLineMatch !== null,
				finalLineHeadingText: finalLineMatch?.[2],
				finalLineHeadingLevel: finalLineMatch?.[1]?.length,
				topLevelOutlineCount: outline.length,
				topLevelHeadings: outline.map((heading) => heading.name),
			},
			"Finished reading note for outline",
		);

		array.sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0));

		if (array[0]) finalOutline.outline = array[0];

		this.logger.debug(
			{
				returnedOutlineCount: finalOutline.outline.length,
				returnedHeadings: finalOutline.outline.map(
					(heading) => heading.name,
				),
				accumulatedOutlineCount: outline.length,
				accumulatedHeadings: outline.map((heading) => heading.name),
				finalOutline,
			},
			"Finished building note outline",
		);
		return finalOutline;
	}

	private makeNode(array: Outline[][]): Outline[][] | undefined {
		if (!array[0]) {
			array.shift();
		}

		const reversedArray = [...array].reverse();

		for (const [i, outlines] of reversedArray.entries()) {
			if (outlines.length === 0) continue;

			const parent = reversedArray[i + 1]?.at(-1);
			if (!parent) {
				if (i !== reversedArray.length) {
					reversedArray.sort(
						(a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0),
					);
					let current = outlines[i];
					if (!current) {
						current = outlines.at(-1);
						if (!current) return;
					}

					const newParent = reversedArray[i + 1]?.at(-1);
					if (!newParent) return reversedArray.reverse();

					newParent.outline.push(current);
					reversedArray[i] = [];
					continue;
				}
				return reversedArray.reverse();
			}

			const current = outlines.at(-1);
			if (!current) return;

			parent.outline.push(current);
			reversedArray[i] = [];
		}
	}

	private async validatePath(path: string): Promise<string | false> {
		const vaultPath = await promises.realpath(this.vaultDir);

		const notePath = await promises.realpath(join(vaultPath, path));

		const relativePath = relative(vaultPath, notePath);
		if (
			relativePath === ".." ||
			relativePath.startsWith(`..${sep}`) ||
			isAbsolute(relativePath)
		) {
			return false;
		}
		return notePath;
	}
}
