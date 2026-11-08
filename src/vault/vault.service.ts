import { createReadStream, promises } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { buffer } from "node:stream/consumers";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "pino";
import type { RestrictionsService } from "../auth/restrictions.service.ts";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { CallerIdentity } from "../auth/caller-identity.ts";

import {
	assertWithinVault,
	resolveNotePath,
	toNotePath,
} from "./vault-paths.ts";

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

export type GetNotePathByNoteNameResult = {
	paths: string[];
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

export type ReadNoteLinesResult = {
	notePath: string;
	startLine: number;
	endLine: number;
	content: string;
	version: string;
};

export class VaultService {
	private readonly readNoteMaxSize: number = 64 * 1024;

	private execFileAsync = promisify(execFile);

	constructor(
		private readonly logger: Logger,
		private readonly vaultDir: string,
		private readonly restrictionsService: RestrictionsService,
	) {
		this.vaultDir = resolve(vaultDir);
	}

	public async createNote(
		path: string,
		content: string,
	): Promise<{ ok: true }> {
		const vaultPath = await promises.realpath(this.vaultDir);

		const notePath = resolveNotePath(vaultPath, path);

		try {
			await writeFile(notePath, content, { flag: "wx" });
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "EEXIST"
			) {
				throw new Error(
					"That note already exists, choose a different note path, or use another appropiate tool",
				);
			} else {
				throw error;
			}
		}

		return {
			ok: true,
		};
	}

	public async getNotes(
		skip: number = 0,
		limit: number = 50,
		identity: CallerIdentity,
	): Promise<GetNotesResult> {
		this.validatePagination(skip, limit);

		this.logger.debug({ skip, limit }, "Getting notes");

		const vaultPath = await promises.realpath(this.vaultDir);
		const entries = await promises.readdir(vaultPath, {
			recursive: true,
			withFileTypes: true,
		});

		const paths = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) =>
				toNotePath(vaultPath, join(entry.parentPath, entry.name)),
			)
			.sort();

		const allowedPaths =
			await this.restrictionsService.filterRestrictedNotes(
				paths.map((path) => join(vaultPath, path)),
				identity,
			);
		const notes = allowedPaths
			.slice(skip, skip + limit)
			.map((path) => toNotePath(vaultPath, path));

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

	public async getNotePathByNoteName(
		noteName: string,
		skip: number,
		limit: number,
		identity: CallerIdentity,
	): Promise<GetNotePathByNoteNameResult> {
		this.validatePagination(skip, limit);

		const result: GetNotePathByNoteNameResult = {
			paths: [],
			pagination: { skip, limit, hasMore: false, nextSkip: skip },
		};

		const vaultPath = await promises.realpath(this.vaultDir);
		const args = [
			"--files",
			"-0",
			"-g",
			`*${noteName}*.md`,
			"--sort",
			"path",
			"--",
			vaultPath,
		];

		let stdout: string;
		try {
			const search = await this.execFileAsync("rg", args);
			stdout = search.stdout;
		} catch (error: unknown) {
			if (error instanceof Error && "code" in error && error.code === 1)
				return result;
			throw error;
		}

		const fileMatches = stdout.split("\0").filter(Boolean);

		if (fileMatches.length === 0) return result;

		const allowedNotes =
			await this.restrictionsService.filterRestrictedNotes(
				fileMatches,
				identity,
			);
		if (allowedNotes.length === 0) return result;

		const notes = allowedNotes
			.slice(skip, skip + limit)
			.map((path) => toNotePath(vaultPath, path));

		return {
			paths: notes,
			pagination: {
				skip,
				limit,
				hasMore: skip + notes.length < allowedNotes.length,
				nextSkip: skip + notes.length,
			},
		};
	}

	public async readNote(
		path: string,
		identity: CallerIdentity,
	): Promise<ReadNoteResult> {
		if (
			!Number.isSafeInteger(this.readNoteMaxSize) ||
			this.readNoteMaxSize < 1
		) {
			throw new RangeError(
				"this.readNoteMaxSize must be a positive integer",
			);
		}

		const notePath = await this.validateAndFilterNote(path, identity);

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
			notePath: toNotePath(
				await promises.realpath(this.vaultDir),
				notePath,
			),
			content: fileBuffer.toString("utf8"),
			version: fileHash.update(fileBuffer).digest("hex"),
		};
	}

	public async readNoteLines(
		path: string,
		startLine: number,
		endLine: number,
		identity: CallerIdentity,
	): Promise<ReadNoteLinesResult> {
		if (
			!Number.isSafeInteger(startLine) ||
			!Number.isSafeInteger(endLine) ||
			startLine < 1 ||
			endLine < startLine
		) {
			throw new RangeError(
				"startLine and endLine must be positive safe integers, and endLine must be greater than or equal to startLine",
			);
		}

		const notePath = await this.validateAndFilterNote(path, identity);

		const stream = createReadStream(notePath, {
			highWaterMark: 10 * 1024,
		});

		let linesRead = 0;
		let remainder = "";
		const targetLines: string[] = [];
		const hash = createHash("sha256");
		const decoder = new StringDecoder("utf8");

		for await (const chunk of stream) {
			hash.update(chunk);
			const text = remainder + decoder.write(chunk);
			const lines = text.split(/\r?\n/);

			// The last item might be only part of a line.
			remainder = lines.pop() ?? "";

			for (const line of lines) {
				linesRead++;

				if (linesRead >= startLine && linesRead <= endLine) {
					targetLines.push(line);
				}
			}
		}

		remainder += decoder.end();
		if (remainder.length > 0) {
			linesRead++;
			if (linesRead >= startLine && linesRead <= endLine) {
				targetLines.push(remainder);
			}
		}

		const content = targetLines.join("\n");
		const versionHash = hash.digest("hex");
		return {
			notePath: toNotePath(
				await promises.realpath(this.vaultDir),
				notePath,
			),
			startLine: startLine,
			endLine: endLine,
			content: content,
			version: versionHash,
		};
	}

	public async getOutline(
		path: string,
		identity: CallerIdentity,
	): Promise<GetOutlineResult> {
		this.logger.debug({ path }, "Getting note outline");

		const notePath = await this.validateAndFilterNote(path, identity);

		const stream = createReadStream(notePath, {
			encoding: "utf8",
			highWaterMark: 10 * 1024,
		});

		const outline: Outline[] = [];
		const finalOutline: GetOutlineResult = {
			notePath: toNotePath(
				await promises.realpath(this.vaultDir),
				notePath,
			),
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
		identity: CallerIdentity,
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
		const vaultPath = await promises.realpath(this.vaultDir);
		const fileNamesArgs = ["-l", "-0", ...searchArgs, "--", vaultPath];

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
			await this.restrictionsService.filterRestrictedNotes(
				fileMatches,
				identity,
			);
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
					path: toNotePath(vaultPath, event.data.path.text),
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

	public async replaceNote(
		path: string,
		content: string,
		expectedVersion: string,
		identity: CallerIdentity,
	): Promise<{ ok: true }> {
		const notePath = await this.validateAndFilterNote(path, identity);

		const stream = createReadStream(notePath, { highWaterMark: 10 * 1024 });
		const hash = createHash("sha256");

		for await (const chunk of stream) {
			hash.update(chunk);
		}

		if (expectedVersion !== hash.digest("hex"))
			throw new Error(
				"VERSION_CONFLICT: The note has changed; read it again before editing",
			);

		await writeFile(notePath, content, { flag: "w" });

		return { ok: true };
	}

	/**
	 * Replace an inclusive, 1-based range; empty content deletes the lines.
	 * Replacement newlines follow the note's first newline style (LF by default).
	 * A terminated range keeps its final separator unless the replacement is empty
	 * or already ends in a newline. A final unterminated range adds no separator.
	 */
	public async replaceNoteLines(
		path: string,
		start: number,
		end: number,
		content: string,
		expectedVersion: string,
		identity: CallerIdentity,
	): Promise<{ ok: true }> {
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 1 ||
			end < start
		) {
			throw new RangeError(
				"start and end must be positive safe integers, and end must be greater than or equal to start",
			);
		}
		if (!/^[a-f0-9]{64}$/i.test(expectedVersion)) {
			throw new TypeError("expectedVersion must be a SHA-256 hex digest");
		}

		const notePath = await this.validateAndFilterNote(path, identity);
		const originalStats = await promises.stat(notePath, { bigint: true });
		const temporaryPath = join(
			dirname(notePath),
			`.obsidian-mcp-${randomUUID()}.tmp`,
		);
		const temporaryFile = await promises.open(temporaryPath, "wx", 0o600);

		async function* replaceLines() {
			const source = createReadStream(notePath, {
				highWaterMark: 64 * 1024,
			});
			const hash = createHash("sha256");
			let line = 1;
			let previousByte: number | undefined;
			let newline: string | undefined;

			function* replacement(terminated: boolean) {
				const separator = newline ?? "\n";
				yield content.replace(/\r?\n/g, separator);
				if (
					terminated &&
					content.length > 0 &&
					!content.endsWith("\n")
				) {
					yield separator;
				}
			}

			for await (const chunk of source) {
				// Hash all original bytes, including the range being discarded.
				hash.update(chunk);
				let copyFrom = 0;
				for (
					let offset = chunk.indexOf(0x0a);
					offset !== -1;
					offset = chunk.indexOf(0x0a, offset + 1)
				) {
					const beforeLF =
						offset === 0 ? previousByte : chunk[offset - 1];
					newline ??= beforeLF === 0x0d ? "\r\n" : "\n";
					if (line === start - 1) {
						yield chunk.subarray(copyFrom, offset + 1);
						copyFrom = offset + 1;
					}
					if (line === end) {
						yield* replacement(true);
						copyFrom = offset + 1;
					}
					line++;
				}
				if (line < start || line > end) {
					yield chunk.subarray(copyFrom);
				}
				previousByte = chunk[chunk.length - 1];
			}

			if (hash.digest("hex") !== expectedVersion.toLowerCase()) {
				throw new Error(
					"VERSION_CONFLICT: The note has changed; read it again before editing",
				);
			}
			// A trailing newline terminates the last line; it does not add a line.
			const unterminated =
				previousByte !== undefined && previousByte !== 0x0a;
			const totalLines = line - 1 + (unterminated ? 1 : 0);
			if (end > totalLines) {
				throw new RangeError(
					`Line range ${start}-${end} exceeds the note's ${totalLines} lines`,
				);
			}
			if (line === end && unterminated) {
				yield* replacement(false);
			}
		}

		try {
			// Pipeline handles backpressure and closes the streams on failures.
			await pipeline(replaceLines(), temporaryFile.createWriteStream());
			await promises.chmod(
				temporaryPath,
				Number(originalStats.mode & 0o777n),
			);
			const currentStats = await promises.stat(notePath, {
				bigint: true,
			});
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
			// Same-directory rename commits only the completed, verified replacement.
			// External writers can still race between the metadata check and rename.
			await promises.rename(temporaryPath, notePath);
			return { ok: true };
		} finally {
			try {
				await temporaryFile.close();
			} finally {
				await promises.rm(temporaryPath, { force: true });
			}
		}
	}

	public async appendToNote(
		path: string,
		content: string,
		expectedVersion: string,
		identity: CallerIdentity,
	): Promise<{ ok: true }> {
		const notePath = await this.validateAndFilterNote(path, identity);

		const stream = createReadStream(notePath, { highWaterMark: 10 * 1024 });
		const hash = createHash("sha256");

		for await (const chunk of stream) {
			hash.update(chunk);
		}

		if (expectedVersion !== hash.digest("hex"))
			throw new Error(
				"VERSION_CONFLICT: The note has changed; read it again before editing",
			);

		try {
			await writeFile(notePath, content, { flag: "a" });
		} catch (error) {
			throw new Error("Failed to append to the file");
		}

		return { ok: true };
	}

	public async beautifyNote(
		path: string,
		content: string,
		expectedVersion: string,
		identity: CallerIdentity,
	): Promise<{ ok: true }> {
		const notePath = await this.validateAndFilterNote(path, identity);

		const hash = createHash("sha256");

		const fileBuffer = await buffer(createReadStream(notePath));
		hash.update(fileBuffer);

		if (expectedVersion !== hash.digest("hex"))
			throw new Error(
				"VERSION_CONFLICT: The note has changed; read it again before editing",
			);

		const finalContent = content + fileBuffer.toString("utf8");

		await writeFile(notePath, finalContent, { flag: "w" });

		return { ok: true };
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

	private async validateAndFilterNote(
		path: string,
		identity: CallerIdentity,
	): Promise<string> {
		const vaultPath = await promises.realpath(this.vaultDir);

		const requestedPath = resolveNotePath(vaultPath, path);
		const notePath = await promises.realpath(requestedPath);
		assertWithinVault(vaultPath, notePath);

		const validNotePath =
			await this.restrictionsService.filterRestrictedNotes(
				[requestedPath],
				identity,
			);

		if (validNotePath.length === 0) {
			throw new Error("Note is restricted");
		}

		if (!validNotePath[0])
			throw new Error(
				"Note is gone... somehow idk man, this shouldn't have happended, try something else",
			);

		return notePath;
	}
}
