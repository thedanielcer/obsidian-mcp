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
	// start: number;
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

		let array: Outline[][] = [];
		const getLevelSizes = () =>
			Array.from({ length: 6 }, (_, level) =>
				Array.isArray(array[level]) ? array[level].length : null,
			);
		const getHeadingsByLevel = () =>
			Array.from({ length: 6 }, (_, level) =>
				Array.isArray(array[level])
					? array[level].map((heading: Outline) => heading.name)
					: null,
			);

		let remainder = "";
		let lastMatchLevel: number = 0;
		let chunkNumber = 0;
		let lineNumber = 0;

		for await (const chunk of stream) {
			chunkNumber += 1;
			const text = remainder + chunk;
			const lines = text.split(/\r?\n/);

			// The last item might be only part of a line.
			remainder = lines.pop() ?? "";

			this.logger.debug(
				{
					chunkNumber,
					chunkLength: chunk.length,
					completeLineCount: lines.length,
					remainderLength: remainder.length,
				},
				"Processing outline stream chunk",
			);

			for (const [i, line] of lines.entries()) {
				lineNumber += 1;
				const match = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);

				if (match && match[2] && match[1]) {
					const currentMatchLevel = match[1].length - 1;
					const previousMatchLevel = lastMatchLevel;
					if (i === 0) lastMatchLevel = 0;

					this.logger.debug(
						{
							chunkNumber,
							lineNumber,
							headingText: match[2],
							headingLevel: currentMatchLevel + 1,
							previousHeadingLevel: previousMatchLevel + 1,
							effectivePreviousHeadingLevel: lastMatchLevel + 1,
							levelInitialized: Array.isArray(
								array[currentMatchLevel],
							),
							levelSizes: getLevelSizes(),
							headingsByLevel: getHeadingsByLevel(),
						},
						"Matched outline heading",
					);

					if (lastMatchLevel > currentMatchLevel) {
						this.logger.debug(
							{
								fromHeadingLevel: lastMatchLevel + 1,
								toHeadingLevel: currentMatchLevel + 1,
								levelSizes: getLevelSizes(),
								headingsByLevel: getHeadingsByLevel(),
							},
							"Making node",
						);

						const node = this.makeNode(array);
						if (node) {
							outline.push(node);
							// array = [];

							this.logger.debug(
								{
									nodeCreated: node !== undefined,
									nodeHeading: node?.name,
									topLevelOutlineCount: outline.length,
									topLevelHeadings: outline.map(
										(heading) => heading.name,
									),
									levelSizes: getLevelSizes(),
									headingsByLevel: getHeadingsByLevel(),
									node,
									outline,
								},
								"Collapsed accumulated outline levels",
							);
						}
					}
					switch (currentMatchLevel) {
						case HeadingLevels.firstLevel:
							lastMatchLevel = HeadingLevels.firstLevel;
							this.logger.debug("pushing lol");
							if (!array[HeadingLevels.firstLevel])
								array[HeadingLevels.firstLevel] = [];
							array[HeadingLevels.firstLevel].push({
								name: match[2],
								outline: [],
							});
							break;
						case HeadingLevels.secondLevel:
							lastMatchLevel = HeadingLevels.secondLevel;
							if (!array[HeadingLevels.secondLevel])
								array[HeadingLevels.secondLevel] = [];
							array[HeadingLevels.secondLevel].push({
								name: match[2],
								outline: [],
							});
							break;
						case HeadingLevels.thirdLevel:
							lastMatchLevel = HeadingLevels.thirdLevel;
							if (!array[HeadingLevels.thirdLevel])
								array[HeadingLevels.thirdLevel] = [];
							array[HeadingLevels.thirdLevel].push({
								name: match[2],
								outline: [],
							});
							break;
						case HeadingLevels.fourthLevel:
							lastMatchLevel = HeadingLevels.fourthLevel;
							if (!array[HeadingLevels.fourthLevel])
								array[HeadingLevels.fourthLevel] = [];
							array[HeadingLevels.fourthLevel].push({
								name: match[2],
								outline: [],
							});
							break;
						case HeadingLevels.fifthLevel:
							lastMatchLevel = HeadingLevels.fifthLevel;
							if (!array[HeadingLevels.fifthLevel])
								array[HeadingLevels.fifthLevel] = [];
							array[HeadingLevels.fifthLevel].push({
								name: match[2],
								outline: [],
							});
							break;
						case HeadingLevels.sixthLevel:
							lastMatchLevel = HeadingLevels.sixthLevel;
							if (!array[HeadingLevels.sixthLevel])
								array[HeadingLevels.sixthLevel] = [];
							array[HeadingLevels.sixthLevel].push({
								name: match[2],
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
							levelSizes: getLevelSizes(),
							headingsByLevel: getHeadingsByLevel(),
						},
						"Stored outline heading",
					);
				}
			}
		}

		const finalLineMatch = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(remainder);

		this.logger.debug(
			{
				chunkCount: chunkNumber,
				processedLineCount: lineNumber,
				remainderLength: remainder.length,
				finalLineIsHeading: finalLineMatch !== null,
				finalLineHeadingText: finalLineMatch?.[2],
				finalLineHeadingLevel: finalLineMatch?.[1]?.length,
				levelSizes: getLevelSizes(),
				headingsByLevel: getHeadingsByLevel(),
				topLevelOutlineCount: outline.length,
				topLevelHeadings: outline.map((heading) => heading.name),
			},
			"Finished reading note for outline",
		);

		// Process the final line if the file doesn't end with a newline.
		// const match = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(remainder);
		// if (match && match[2]) {
		// 	outline.push(match[2]);
		// }
		if (outline[0]) finalOutline.outline.push(outline[0]);
		this.logger.debug(
			{
				returnedOutlineCount: finalOutline.outline.length,
				returnedHeadings: finalOutline.outline.map(
					(heading) => heading.name,
				),
				accumulatedOutlineCount: outline.length,
				accumulatedHeadings: outline.map((heading) => heading.name),
				levelSizes: getLevelSizes(),
				headingsByLevel: getHeadingsByLevel(),
				finalOutline,
			},
			"Finished building note outline",
		);
		return finalOutline;
	}

	private makeNode(array: Outline[][]): Outline | undefined {
		const reversedArray = [...array].reverse();

		for (const [i, outlines] of reversedArray.entries()) {
			if (outlines.length === 0) continue;

			const parent = reversedArray[i + 1]?.[0];
			if (!parent) continue;

			parent.outline = outlines;
		}

		const levelOneOutline = reversedArray.reverse()[0];
		if (levelOneOutline) {
			const outline = levelOneOutline[0];
			if (outline) {
				return outline;
			}
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

	private isFirstLevel(level: string): boolean {
		if (level === "#") return true;
		return false;
	}
}
