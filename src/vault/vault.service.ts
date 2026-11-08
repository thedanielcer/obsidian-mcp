import { createReadStream, promises } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { buffer } from "node:stream/consumers";
import type { Logger } from "pino";
import type { RestrictionsService } from "../auth/restrictions.service.ts";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

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
	lineNumber: number;
	outline: Outline[];
};

export type RipgrepMatch = {
	type: "match";
	data: {
		path: { text: string };
		lines: { text: string };
		line_number: number;
		absolute_offset: number;
		submatches: {
			match: { text: string };
			start: number;
			end: number;
		}[];
	};
};

export type Matches = {
	path: string;
	line: number;
	text: string;
};

export type Pagination = {
	skip: number;
	limit: number;
	hasMore: boolean;
	nextSkip: number;
};

export type ReadNoteResult = {
	notePath: string;
	content: string;
	version: string;
};

export type GetNotesResult = {
	notes: string[];
	pagination: Pagination;
};

export type GetOutlineResult = {
	notePath: string;
	outline: Outline[];
};

export type SearchNotesResult = {
	matches: Matches[];
	pagination: Pagination;
};

export class VaultService {
	private readonly readNoteMaxSize: number = 64 * 1024;

	private execFileAsync = promisify(execFile);

	constructor(
		private readonly logger: Logger,
		private readonly vaultDir: string,
		private readonly restrictionsService: RestrictionsService,
	) {}

	public async getNotes(
		skip: number = 0,
		limit: number = 50,
	): Promise<GetNotesResult> {
		this.validatePagination(skip, limit);

		this.logger.debug({ skip, limit }, "Getting notes");

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

		const allowedPaths =
			await this.restrictionsService.filterRestrictedNotes(
				paths.map((path) => join(this.vaultDir, path)),
			);
		const notes = allowedPaths
			.slice(skip, skip + limit)
			.map((path) => relative(this.vaultDir, path));

		return {
			notes,
			pagination: {
				skip,
				limit,
				hasMore: skip + notes.length < allowedPaths.length,
				nextSkip: skip + notes.length,
			},
		};
	}

	public async readNote(path: string): Promise<ReadNoteResult> {
		if (
			!Number.isSafeInteger(this.readNoteMaxSize) ||
			this.readNoteMaxSize < 1
		) {
			throw new RangeError(
				"this.readNoteMaxSize must be a positive integer",
			);
		}

		const notePath = await this.validateAndFilterNote(path);

		const fileStats = await promises.stat(notePath);
		if (fileStats.size > this.readNoteMaxSize) {
			throw new Error(
				`NOTE_TOO_LARGE: This note is ${fileStats.size} bytes` +
					`\nreadNote supports notes up to ${this.readNoteMaxSize} bytes` +
					"\nNo note content was returned",
			);
		}

		const fileHash = createHash("sha256");

		// end is inclusive: the extra byte tells us whether the note exceeds the limit.
		const fileBuffer = await buffer(
			createReadStream(notePath, { start: 0, end: this.readNoteMaxSize }),
		);
		if (fileBuffer.length > this.readNoteMaxSize) {
			throw new Error(
				`NOTE_TOO_LARGE: This note is ${fileBuffer.length} bytes` +
					`\nreadNote supports notes up to ${this.readNoteMaxSize} bytes` +
					"\nNo note content was returned",
			);
		}

		return {
			notePath: notePath,
			content: fileBuffer.toString("utf8"),
			version: fileHash.update(fileBuffer).digest("hex"),
		};
	}

	public async getOutline(path: string): Promise<GetOutlineResult> {
		this.logger.debug({ path }, "Getting note outline");

		const notePath = await this.validateAndFilterNote(path);

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
							lineNumber: lineNumber,
							outline: [],
						});
						break;
					case HeadingLevels.secondLevel:
						lastMatchLevel = HeadingLevels.secondLevel;
						if (!array[HeadingLevels.secondLevel])
							array[HeadingLevels.secondLevel] = [];
						array[HeadingLevels.secondLevel].push({
							name: match[2],
							lineNumber: lineNumber,
							outline: [],
						});
						break;
					case HeadingLevels.thirdLevel:
						lastMatchLevel = HeadingLevels.thirdLevel;
						if (!array[HeadingLevels.thirdLevel])
							array[HeadingLevels.thirdLevel] = [];
						array[HeadingLevels.thirdLevel].push({
							name: match[2],
							lineNumber: lineNumber,
							outline: [],
						});
						break;
					case HeadingLevels.fourthLevel:
						lastMatchLevel = HeadingLevels.fourthLevel;
						if (!array[HeadingLevels.fourthLevel])
							array[HeadingLevels.fourthLevel] = [];
						array[HeadingLevels.fourthLevel].push({
							name: match[2],
							lineNumber: lineNumber,
							outline: [],
						});
						break;
					case HeadingLevels.fifthLevel:
						lastMatchLevel = HeadingLevels.fifthLevel;
						if (!array[HeadingLevels.fifthLevel])
							array[HeadingLevels.fifthLevel] = [];
						array[HeadingLevels.fifthLevel].push({
							name: match[2],
							lineNumber: lineNumber,
							outline: [],
						});
					case HeadingLevels.sixthLevel:
						lastMatchLevel = HeadingLevels.sixthLevel;
						if (!array[HeadingLevels.sixthLevel])
							array[HeadingLevels.sixthLevel] = [];
						array[HeadingLevels.sixthLevel].push({
							name: match[2],
							lineNumber: lineNumber,
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

	public async searchNotes(
		query: string,
		regex: boolean,
		caseSensitive: boolean,
		skip: number,
		limit: number,
	): Promise<SearchNotesResult> {
		this.validatePagination(skip, limit);

		const result: SearchNotesResult = {
			matches: [],
			pagination: { skip, limit, hasMore: false, nextSkip: skip },
		};
		const searchArgs = ["-g", "*.md"];

		if (!regex) searchArgs.push("--fixed-strings");

		searchArgs.push(caseSensitive ? "--case-sensitive" : "--ignore-case");
		searchArgs.push("-e", query);
		const fileNamesArgs = ["-l", "-0", ...searchArgs, "--", this.vaultDir];

		let stdout: string;
		try {
			const search = await this.execFileAsync("rg", fileNamesArgs);
			stdout = search.stdout;
		} catch (error: unknown) {
			if (error instanceof Error && "code" in error && error.code === 1)
				return result;
			throw error;
		}

		const fileMatches = stdout.split("\0").filter(Boolean);

		if (fileMatches.length === 0) return result;

		const allowedNotes =
			await this.restrictionsService.filterRestrictedNotes(fileMatches);
		if (allowedNotes.length === 0) return result;

		const controller = new AbortController();

		const { signal } = controller;

		const matchesArgs = [
			"--json",
			"--sort=path",
			...searchArgs,
			"--",
			...allowedNotes.toSorted(),
		];
		const rg = spawn("rg", matchesArgs, { signal });

		let processError: Error | undefined;
		let processClosed = false;
		let stderr = "";
		const closed = new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve) => {
			rg.on("error", (error) => {
				if (signal.aborted && error.name === "AbortError") return;
				processError ??= error;
			});
			rg.once("close", (code, exitSignal) => {
				processClosed = true;
				resolve({ code, signal: exitSignal });
			});
		});

		rg.stderr.setEncoding("utf8");
		rg.stderr.on("data", (chunk: string) => {
			// Drain stderr without retaining an unbounded error log.
			stderr = (stderr + chunk).slice(-8192);
		});

		const lineReader = createInterface({
			input: rg.stdout,
			crlfDelay: Infinity,
		});

		let skipped = 0;

		const matches = result.matches;
		let finishedReading = false;

		try {
			for await (const line of lineReader) {
				const event: RipgrepMatch = JSON.parse(line);
				if (event.type !== "match") continue;

				if (skipped < skip) {
					skipped++;
					continue;
				}

				// An extra match confirms that another page exists.
				if (matches.length === limit) {
					result.pagination.hasMore = true;
					controller.abort();
					break;
				}

				matches.push({
					path: event.data.path.text,
					line: event.data.line_number,
					text: event.data.lines.text,
				});
			}
			finishedReading = true;
		} finally {
			lineReader.close();
			if (!finishedReading && !processClosed && !signal.aborted) {
				controller.abort();
			}
			await closed;
		}

		if (processError) throw processError;

		const { code, signal: exitSignal } = await closed;
		if (!signal.aborted && code !== 0 && code !== 1) {
			throw new Error(
				`ripgrep failed (${exitSignal ?? `exit code ${code}`}): ${stderr.trim()}`,
			);
		}

		result.pagination.nextSkip = skip + matches.length;
		return result;
	}

	private validatePagination(skip: number, limit: number): void {
		if (
			!Number.isSafeInteger(skip) ||
			skip < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			!Number.isSafeInteger(skip + limit)
		) {
			throw new RangeError(
				"skip must be a non-negative safe integer, limit must be a positive safe integer, and skip + limit must be a safe integer",
			);
		}
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

	private async validateAndFilterNote(path: string): Promise<string> {
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

		const validNotePath =
			await this.restrictionsService.filterRestrictedNotes([notePath]);

		if (validNotePath.length === 0) {
			throw new Error("Note is restricted");
		}

		if (!validNotePath[0])
			throw new Error("Note is gone... somehow idk man");

		return validNotePath[0];
	}
}
