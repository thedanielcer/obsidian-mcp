import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import pino from "pino";
import pretty from "pino-pretty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultService } from "../../src/vault/vault.service.ts";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";
import {
	authorizedIdentity,
	createRestrictedReaderEmails,
	unauthorizedIdentity,
} from "../fixtures/identities.ts";

describe("VaultService", () => {
	let testDir: string;
	let vaultDir: string;
	let restrictionsService: RestrictionsService;
	let service: VaultService;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "obsidian-mcp-"));
		vaultDir = join(testDir, "vault");
		await mkdir(vaultDir);
		const logLevel = process.env.TEST_LOG_LEVEL ?? "silent";
		const logger =
			logLevel === "silent"
				? pino({ level: "silent" })
				: pino(
						{ level: logLevel },
						pretty({
							colorize: true,
							translateTime: "SYS:standard",
							ignore: "pid,hostname",
							sync: true,
						}),
					);
		const restrictedPaths = join(testDir, "restrictions.json");
		await writeFile(restrictedPaths, "[]");
		restrictionsService = new RestrictionsService(
			logger,
			restrictedPaths,
			createRestrictedReaderEmails(),
			vaultDir,
		);
		service = new VaultService(logger, vaultDir, restrictionsService);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	describe("getNotes", () => {
		it("returns Markdown files recursively in sorted order", async () => {
			await mkdir(join(vaultDir, "folder"));
			await Promise.all([
				writeFile(join(vaultDir, "b.md"), "B"),
				writeFile(join(vaultDir, "a.md"), "A"),
				writeFile(join(vaultDir, "folder", "c.md"), "C"),
				writeFile(join(vaultDir, "ignored.txt"), "not a note"),
			]);

			await expect(
				service.getNotes(0, 50, unauthorizedIdentity),
			).resolves.toEqual({
				notes: ["a.md", "b.md", "folder/c.md"],
				pagination: {
					skip: 0,
					limit: 50,
					hasMore: false,
					nextSkip: 3,
				},
			});
		});

		it("returns an empty list for an empty vault", async () => {
			await expect(
				service.getNotes(0, 50, unauthorizedIdentity),
			).resolves.toEqual({
				notes: [],
				pagination: {
					skip: 0,
					limit: 50,
					hasMore: false,
					nextSkip: 0,
				},
			});
		});

		it("paginates the sorted note list", async () => {
			await Promise.all(
				["01.md", "02.md", "03.md", "04.md", "05.md"].map((name) =>
					writeFile(join(vaultDir, name), name),
				),
			);

			const first = await service.getNotes(0, 2, unauthorizedIdentity);
			expect(first).toEqual({
				notes: ["01.md", "02.md"],
				pagination: {
					skip: 0,
					limit: 2,
					hasMore: true,
					nextSkip: 2,
				},
			});
			const second = await service.getNotes(
				first.pagination.nextSkip,
				2,
				unauthorizedIdentity,
			);
			expect(second).toEqual({
				notes: ["03.md", "04.md"],
				pagination: {
					skip: 2,
					limit: 2,
					hasMore: true,
					nextSkip: 4,
				},
			});
			await expect(
				service.getNotes(
					second.pagination.nextSkip,
					2,
					unauthorizedIdentity,
				),
			).resolves.toEqual({
				notes: ["05.md"],
				pagination: {
					skip: 4,
					limit: 2,
					hasMore: false,
					nextSkip: 5,
				},
			});
			await expect(
				service.getNotes(6, 2, unauthorizedIdentity),
			).resolves.toEqual({
				notes: [],
				pagination: {
					skip: 6,
					limit: 2,
					hasMore: false,
					nextSkip: 6,
				},
			});
		});

		it("excludes restricted notes before applying skip and limit", async () => {
			await writeFile(
				join(vaultDir, "01.md"),
				"---\nrestricted: true\n---\nsecret\n",
			);
			await writeFile(join(vaultDir, "02.md"), "visible\n");
			await writeFile(join(vaultDir, "03.md"), "visible\n");
			await writeFile(join(vaultDir, "04.md"), "secret\n");
			await writeFile(
				join(testDir, "restrictions.json"),
				JSON.stringify([join(vaultDir, "04.md")]),
			);

			await expect(
				service.getNotes(0, 1, unauthorizedIdentity),
			).resolves.toEqual({
				notes: ["02.md"],
				pagination: {
					skip: 0,
					limit: 1,
					hasMore: true,
					nextSkip: 1,
				},
			});
			await expect(
				service.getNotes(1, 1, unauthorizedIdentity),
			).resolves.toEqual({
				notes: ["03.md"],
				pagination: {
					skip: 1,
					limit: 1,
					hasMore: false,
					nextSkip: 2,
				},
			});
			await expect(
				service.getNotes(0, 10, authorizedIdentity),
			).resolves.toEqual({
				notes: ["01.md", "02.md", "03.md", "04.md"],
				pagination: {
					skip: 0,
					limit: 10,
					hasMore: false,
					nextSkip: 4,
				},
			});
		});

		it.each([
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		])("rejects invalid skip value %s", async (skip) => {
			await expect(
				service.getNotes(skip, 10, unauthorizedIdentity),
			).rejects.toBeInstanceOf(RangeError);
		});

		it.each([
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		])("rejects invalid limit value %s", async (limit) => {
			await expect(
				service.getNotes(0, limit, unauthorizedIdentity),
			).rejects.toBeInstanceOf(RangeError);
		});

		it("rejects a pagination window beyond safe integer precision", async () => {
			await expect(
				service.getNotes(
					Number.MAX_SAFE_INTEGER,
					1,
					unauthorizedIdentity,
				),
			).rejects.toBeInstanceOf(RangeError);
		});
	});

	describe("readNote", () => {
		it("reads a nested UTF-8 Markdown note", async () => {
			await mkdir(join(vaultDir, "folder"));
			const expected = "# H\u00e9llo\n\nA note \u{1f44b}";
			const notePath = join(vaultDir, "folder", "note.md");
			await writeFile(notePath, expected);

			await expect(
				service.readNote(
					join("folder", "note.md"),
					unauthorizedIdentity,
				),
			).resolves.toEqual({
				notePath: relative(vaultDir, notePath).split(sep).join("/"),
				content: expected,
				version: createHash("sha256").update(expected).digest("hex"),
			});
		});

		it("reads a note at the 65,536-byte limit", async () => {
			const notePath = join(vaultDir, "limit.md");
			const expected = Buffer.alloc(65_536, "a");
			await writeFile(notePath, expected);

			const result = await service.readNote(
				"limit.md",
				unauthorizedIdentity,
			);

			expect(Buffer.byteLength(result.content)).toBe(65_536);
			expect(result.notePath).toBe(
				relative(vaultDir, notePath).split(sep).join("/"),
			);
			expect(result.version).toBe(
				createHash("sha256").update(expected).digest("hex"),
			);
		});

		it("rejects a note larger than 65,536 bytes", async () => {
			await writeFile(
				join(vaultDir, "too-large.md"),
				Buffer.alloc(65_537, "a"),
			);

			await expect(
				service.readNote("too-large.md", unauthorizedIdentity),
			).rejects.toThrow(/NOTE_TOO_LARGE: This note is 65537 bytes/);
		});

		it("rejects traversal to an existing file outside the vault", async () => {
			await writeFile(join(testDir, "outside.md"), "secret");

			await expect(
				service.readNote("../outside.md", unauthorizedIdentity),
			).rejects.toThrow("Note path must be inside the vault");
		});

		it("rejects an absolute path outside the vault", async () => {
			const outsidePath = join(testDir, "outside.md");
			await writeFile(outsidePath, "secret");
			expect(isAbsolute(outsidePath)).toBe(true);

			await expect(
				service.readNote(outsidePath, unauthorizedIdentity),
			).rejects.toThrow();
		});

		it("rejects a missing note", async () => {
			await expect(
				service.readNote("missing.md", unauthorizedIdentity),
			).rejects.toThrow();
		});

		it("allows only an authorized identity to read a restricted note", async () => {
			const notePath = join(vaultDir, "restricted-read.md");
			const content = "---\nrestricted: true\n---\n# Private\n";
			await writeFile(notePath, content);

			await expect(
				service.readNote("restricted-read.md", unauthorizedIdentity),
			).rejects.toThrow("Note is restricted");
			await expect(
				service.readNote("restricted-read.md", authorizedIdentity),
			).resolves.toMatchObject({ content });
		});
	});

	describe("createNote", () => {
		it("creates a note when the file does not exist", async () => {
			const notePath = join(vaultDir, "new-note.md");
			const content = "# Newly created note\n";

			await expect(
				service.createNote(
					"new-note.md",
					content,
					unauthorizedIdentity,
				),
			).resolves.toEqual({ ok: true });
			await expect(readFile(notePath, "utf8")).resolves.toBe(content);
		});
	});

	describe("replaceNote", () => {
		it("rejects when the note does not exist", async () => {
			await expect(
				service.replaceNote(
					"missing.md",
					"replacement",
					createHash("sha256").update("").digest("hex"),
					unauthorizedIdentity,
				),
			).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	describe("appendToNote", () => {
		const versionOf = (content: string | Buffer) =>
			createHash("sha256").update(content).digest("hex");

		it("preserves the initial contents and appends the new contents exactly", async () => {
			const notePath = join(vaultDir, "note.md");
			const initial = "# Existing heading\n\nExisting paragraph.";
			const appended = "\n\n## Appended heading\n\nAppended paragraph.";
			await writeFile(notePath, initial);

			await expect(
				service.appendToNote(
					"note.md",
					appended,
					versionOf(initial),
					unauthorizedIdentity,
				),
			).resolves.toEqual({ ok: true });
			await expect(readFile(notePath, "utf8")).resolves.toBe(
				initial + appended,
			);
		});

		it("preserves the order of repeated UTF-8 appends", async () => {
			const notePath = join(vaultDir, "repeated.md");
			const initial = "Inicio";
			const second = " → segundo";
			const final = " → final 👋";
			await writeFile(notePath, initial);

			await service.appendToNote(
				"repeated.md",
				second,
				versionOf(initial),
				unauthorizedIdentity,
			);
			await service.appendToNote(
				"repeated.md",
				final,
				versionOf(initial + second),
				unauthorizedIdentity,
			);

			await expect(readFile(notePath, "utf8")).resolves.toBe(
				initial + second + final,
			);
		});

		it("allows an empty append without changing the note", async () => {
			const notePath = join(vaultDir, "unchanged.md");
			const initial = "Keep this exactly as-is.";
			await writeFile(notePath, initial);

			await expect(
				service.appendToNote(
					"unchanged.md",
					"",
					versionOf(initial),
					unauthorizedIdentity,
				),
			).resolves.toEqual({ ok: true });
			await expect(readFile(notePath, "utf8")).resolves.toBe(initial);
		});

		it("rejects a stale expected version without changing the note", async () => {
			const notePath = join(vaultDir, "version-conflict.md");
			const initial = "Current contents";
			await writeFile(notePath, initial);

			await expect(
				service.appendToNote(
					"version-conflict.md",
					"must not be appended",
					versionOf("Older contents"),
					unauthorizedIdentity,
				),
			).rejects.toThrow("VERSION_CONFLICT");
			await expect(readFile(notePath, "utf8")).resolves.toBe(initial);
		});

		it("rejects when the note does not exist", async () => {
			await expect(
				service.appendToNote(
					"missing.md",
					"new content",
					versionOf(""),
					unauthorizedIdentity,
				),
			).rejects.toThrow();
		});

		it("rejects a restricted note without modifying it", async () => {
			const notePath = join(vaultDir, "restricted.md");
			const initial = "---\nrestricted: true\n---\n# Private\n";
			await writeFile(notePath, initial);

			await expect(
				service.appendToNote(
					"restricted.md",
					"must not be appended",
					versionOf(initial),
					unauthorizedIdentity,
				),
			).rejects.toThrow("Note is restricted");
			await expect(readFile(notePath, "utf8")).resolves.toBe(initial);

			await expect(
				service.appendToNote(
					"restricted.md",
					"authorized append",
					versionOf(initial),
					authorizedIdentity,
				),
			).resolves.toEqual({ ok: true });
			await expect(readFile(notePath, "utf8")).resolves.toBe(
				initial + "authorized append",
			);
		});

		it("rejects traversal outside the vault without modifying the file", async () => {
			const outsidePath = join(testDir, "outside-append.md");
			const initial = "Outside the vault";
			await writeFile(outsidePath, initial);

			await expect(
				service.appendToNote(
					"../outside-append.md",
					"must not be appended",
					versionOf(initial),
					unauthorizedIdentity,
				),
			).rejects.toThrow("Note path must be inside the vault");
			await expect(readFile(outsidePath, "utf8")).resolves.toBe(initial);
		});
	});

	describe("readNoteLines", () => {
		it.each([
			{
				content: "one\ntwo\nthree\nfour\n",
				start: 2,
				end: 3,
				expected: "two\nthree",
			},
			{
				content: "one\ntwo\nthree\nfour\n",
				start: 2,
				end: 4,
				expected: "two\nthree\nfour",
			},
			{ content: "one\ntwo\n", start: 1, end: 1, expected: "one" },
			{ content: "one\ntwo", start: 2, end: 2, expected: "two" },
			{ content: "one", start: 1, end: 1, expected: "one" },
			{
				content: "one\n\nthree\n",
				start: 1,
				end: 3,
				expected: "one\n\nthree",
			},
			{ content: "one\ntwo", start: 2, end: 10, expected: "two" },
			{ content: "one\ntwo\n", start: 3, end: 4, expected: "" },
			{ content: "", start: 1, end: 2, expected: "" },
			{
				content: "one\r\ntwo\r\nthree",
				start: 2,
				end: 3,
				expected: "two\nthree",
			},
		])(
			"reads inclusive lines $start-$end from $content",
			async ({ content, start, end, expected }) => {
				const notePath = join(vaultDir, "lines.md");
				await writeFile(notePath, content);

				await expect(
					service.readNoteLines(
						"lines.md",
						start,
						end,
						unauthorizedIdentity,
					),
				).resolves.toEqual({
					notePath: relative(vaultDir, notePath).split(sep).join("/"),
					startLine: start,
					endLine: end,
					content: expected,
					version: createHash("sha256").update(content).digest("hex"),
				});
			},
		);

		it("handles CRLF and UTF-8 characters split across stream chunks", async () => {
			// The first CR falls at byte 10,239; the emoji also spans a 10 KiB boundary.
			const firstLine = "x".repeat(10 * 1024 - 1);
			const secondLine = "y".repeat(10 * 1024 - 4) + "😀";
			const content = `${firstLine}\r\n${secondLine}\r\nlast`;
			await writeFile(join(vaultDir, "chunks.md"), content);

			await expect(
				service.readNoteLines("chunks.md", 2, 3, unauthorizedIdentity),
			).resolves.toMatchObject({
				content: `${secondLine}\nlast`,
				version: createHash("sha256").update(content).digest("hex"),
			});
		});

		it("hashes bytes beyond the requested range and changes version when they change", async () => {
			const notePath = join(vaultDir, "version.md");
			const content = "selected\n" + "unselected\n".repeat(3000);
			await writeFile(notePath, content);
			const first = await service.readNoteLines(
				"version.md",
				1,
				1,
				unauthorizedIdentity,
			);
			expect(first.content).toBe("selected");
			expect(first.version).toBe(
				createHash("sha256").update(content).digest("hex"),
			);

			const updated = content + "changed suffix";
			await writeFile(notePath, updated);
			const second = await service.readNoteLines(
				"version.md",
				1,
				1,
				unauthorizedIdentity,
			);
			expect(second.content).toBe(first.content);
			expect(second.version).toBe(
				createHash("sha256").update(updated).digest("hex"),
			);
			expect(second.version).not.toBe(first.version);
		});

		it("hashes original file bytes even when UTF-8 decoding replaces invalid bytes", async () => {
			const content = Buffer.from([0x6f, 0x6e, 0x65, 0x0a, 0xff]);
			await writeFile(join(vaultDir, "bytes.md"), content);

			await expect(
				service.readNoteLines("bytes.md", 1, 2, unauthorizedIdentity),
			).resolves.toMatchObject({
				content: "one\n\ufffd",
				version: createHash("sha256").update(content).digest("hex"),
			});
		});

		it.each([
			[0, 1],
			[-1, 1],
			[1.5, 2],
			[Number.NaN, 2],
			[Number.POSITIVE_INFINITY, 2],
			[Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1],
			[1, 0],
			[2, 1],
			[1, 1.5],
			[1, Number.NaN],
			[1, Number.POSITIVE_INFINITY],
			[1, Number.MAX_SAFE_INTEGER + 1],
		])(
			"rejects invalid range %s–%s before accessing the file",
			async (start, end) => {
				await expect(
					service.readNoteLines(
						"missing.md",
						start,
						end,
						unauthorizedIdentity,
					),
				).rejects.toBeInstanceOf(RangeError);
			},
		);

		it("rejects a missing note when given a valid line range", async () => {
			await expect(
				service.readNoteLines("missing.md", 1, 1, unauthorizedIdentity),
			).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("allows only an authorized identity to read lines from a restricted note", async () => {
			const notePath = join(vaultDir, "restricted-lines.md");
			const content = "---\nrestricted: true\n---\nsecret\n";
			await writeFile(notePath, content);

			await expect(
				service.readNoteLines(
					"restricted-lines.md",
					4,
					4,
					unauthorizedIdentity,
				),
			).rejects.toThrow("Note is restricted");
			await expect(
				service.readNoteLines(
					"restricted-lines.md",
					4,
					4,
					authorizedIdentity,
				),
			).resolves.toMatchObject({ content: "secret" });
		});
	});

	describe("getOutline", () => {
		it("builds a nested outline from heading levels", async () => {
			const notePath = join(vaultDir, "nested.md");
			await writeFile(
				notePath,
				[
					"```JSON",
					"# Fake heading",
					"## Second Fake heading",
					"```",
					"# Parent",
					"Some body text",
					"## Child ###",
					"### Grandchild",
					"## Second child",
					"### Grandchild to second child",
					"## Third child",
					"# Second parent",
					"## Child to second parent",
					"### Grandchild to child of second parent",
					"## Second child to second parent",
					"### Grandchild to second child of second parent",
					"# Third parent",
					"## Child to third parent",
					"```JSON",
					"# Fake heading",
					"## Second Fake heading",
					"```",
					"### Grandchild to child to third parent",
					"```JSON",
					"# Fake heading",
					"## Second Fake heading",
					"```",
				].join("\n"),
			);

			await expect(
				service.getOutline("nested.md", unauthorizedIdentity),
			).resolves.toEqual({
				notePath: relative(vaultDir, notePath).split(sep).join("/"),
				outline: [
					{
						name: "Parent",
						lineNumber: 5,
						outline: [
							{
								name: "Child",
								lineNumber: 7,
								outline: [
									{
										name: "Grandchild",
										lineNumber: 8,
										outline: [],
									},
								],
							},
							{
								name: "Second child",
								lineNumber: 9,
								outline: [
									{
										name: "Grandchild to second child",
										lineNumber: 10,
										outline: [],
									},
								],
							},
							{
								name: "Third child",
								lineNumber: 11,
								outline: [],
							},
						],
					},
					{
						name: "Second parent",
						lineNumber: 12,
						outline: [
							{
								name: "Child to second parent",
								lineNumber: 13,
								outline: [
									{
										name: "Grandchild to child of second parent",
										lineNumber: 14,
										outline: [],
									},
								],
							},
							{
								name: "Second child to second parent",
								lineNumber: 15,
								outline: [
									{
										name: "Grandchild to second child of second parent",
										lineNumber: 16,
										outline: [],
									},
								],
							},
						],
					},
					{
						name: "Third parent",
						lineNumber: 17,
						outline: [
							{
								name: "Child to third parent",
								lineNumber: 18,
								outline: [
									{
										name: "Grandchild to child to third parent",
										lineNumber: 23,
										outline: [],
									},
								],
							},
						],
					},
				],
			});
		});

		it("promotes a second-level heading when the note starts at level two", async () => {
			const notePath = join(vaultDir, "starts-at-level-two.md");
			await writeFile(
				notePath,
				"## Starts at level two\n### Nested below it\n# Another parent\n## Its child",
			);

			await expect(
				service.getOutline(
					"starts-at-level-two.md",
					unauthorizedIdentity,
				),
			).resolves.toEqual({
				notePath: relative(vaultDir, notePath).split(sep).join("/"),
				outline: [
					{
						name: "Starts at level two",
						lineNumber: 1,
						outline: [
							{
								name: "Nested below it",
								lineNumber: 2,
								outline: [],
							},
						],
					},
					{
						name: "Another parent",
						lineNumber: 3,
						outline: [
							{ name: "Its child", lineNumber: 4, outline: [] },
						],
					},
				],
			});
		});

		it("keeps earlier second-level headings as siblings when a first-level heading appears later", async () => {
			const notePath = join(vaultDir, "late-first-level-heading.md");
			await writeFile(
				notePath,
				["## 1", "### 1.1", "## 2", "### 2.1", "# 3", "## 3.1"].join(
					"\n",
				),
			);

			await expect(
				service.getOutline(
					"late-first-level-heading.md",
					unauthorizedIdentity,
				),
			).resolves.toEqual({
				notePath: relative(vaultDir, notePath).split(sep).join("/"),
				outline: [
					{
						name: "1",
						lineNumber: 1,
						outline: [{ name: "1.1", lineNumber: 2, outline: [] }],
					},
					{
						name: "2",
						lineNumber: 3,
						outline: [{ name: "2.1", lineNumber: 4, outline: [] }],
					},
					{
						name: "3",
						lineNumber: 5,
						outline: [{ name: "3.1", lineNumber: 6, outline: [] }],
					},
				],
			});
		});

		it("attaches a skipped heading level to the nearest available parent", async () => {
			const notePath = join(vaultDir, "skipped-level.md");
			await writeFile(notePath, "# Parent\n### Level three child");

			await expect(
				service.getOutline("skipped-level.md", unauthorizedIdentity),
			).resolves.toEqual({
				notePath: relative(vaultDir, notePath).split(sep).join("/"),
				outline: [
					{
						name: "Parent",
						lineNumber: 1,
						outline: [
							{
								name: "Level three child",
								lineNumber: 2,
								outline: [],
							},
						],
					},
				],
			});
		});

		it.each([
			{
				name: "keeps an H4 under its H2 parent when the final branch skips H3",
				markdown: "# A\n## B\n#### C\n",
				outline: [
					{
						name: "A",
						lineNumber: 1,
						outline: [
							{
								name: "B",
								lineNumber: 2,
								outline: [
									{ name: "C", lineNumber: 3, outline: [] },
								],
							},
						],
					},
				],
			},
			{
				name: "keeps the H2 parent when returning from H4 to H3",
				markdown: "# A\n## B\n#### C\n### D\n",
				outline: [
					{
						name: "A",
						lineNumber: 1,
						outline: [
							{
								name: "B",
								lineNumber: 2,
								outline: [
									{ name: "C", lineNumber: 3, outline: [] },
									{ name: "D", lineNumber: 4, outline: [] },
								],
							},
						],
					},
				],
			},
			{
				name: "keeps an H2 under the H1 after a skipped H3",
				markdown: "# A\n### B\n## C\n### D",
				outline: [
					{
						name: "A",
						lineNumber: 1,
						outline: [
							{ name: "B", lineNumber: 2, outline: [] },
							{
								name: "C",
								lineNumber: 3,
								outline: [
									{ name: "D", lineNumber: 4, outline: [] },
								],
							},
						],
					},
				],
			},
			{
				name: "keeps an H3 under a later H1 when the new branch skips H2",
				markdown: "## A\n### B\n# C\n### D",
				outline: [
					{
						name: "A",
						lineNumber: 1,
						outline: [{ name: "B", lineNumber: 2, outline: [] }],
					},
					{
						name: "C",
						lineNumber: 3,
						outline: [{ name: "D", lineNumber: 4, outline: [] }],
					},
				],
			},
			{
				name: "preserves sibling order after returning across multiple skipped levels",
				markdown: "# A\n#### B\n\n## C\n",
				outline: [
					{
						name: "A",
						lineNumber: 1,
						outline: [
							{ name: "B", lineNumber: 2, outline: [] },
							{ name: "C", lineNumber: 4, outline: [] },
						],
					},
				],
			},
			{
				name: "keeps earlier roots and their children when a shallower root appears below H1",
				markdown: "### A\n##### B\n## C\n#### D\n",
				outline: [
					{
						name: "A",
						lineNumber: 1,
						outline: [{ name: "B", lineNumber: 2, outline: [] }],
					},
					{
						name: "C",
						lineNumber: 3,
						outline: [{ name: "D", lineNumber: 4, outline: [] }],
					},
				],
			},
		])("$name", async ({ markdown, outline }) => {
			const notePath = "skipped-heading-levels.md";
			await writeFile(join(vaultDir, notePath), markdown);

			await expect(
				service.getOutline(notePath, unauthorizedIdentity),
			).resolves.toEqual({ notePath, outline });
		});

		it.each([
			{ lineEnding: "LF", separator: "\n", hasTrailingNewline: false },
			{ lineEnding: "LF", separator: "\n", hasTrailingNewline: true },
			{
				lineEnding: "CRLF",
				separator: "\r\n",
				hasTrailingNewline: false,
			},
			{
				lineEnding: "CRLF",
				separator: "\r\n",
				hasTrailingNewline: true,
			},
		])(
			"ignores a final heading inside an unclosed backtick fence ($lineEnding, trailing newline: $hasTrailingNewline)",
			async ({ separator, hasTrailingNewline }) => {
				const notePath = "unclosed-fence.md";
				const finalLineEnding = hasTrailingNewline ? separator : "";
				await writeFile(
					join(vaultDir, notePath),
					"```" + separator + "# Hidden" + finalLineEnding,
				);

				await expect(
					service.getOutline(notePath, unauthorizedIdentity),
				).resolves.toEqual({ notePath, outline: [] });
			},
		);

		it("keeps the opening fence length across chunks and resumes after a valid closing fence", async () => {
			const notePath = "fence-across-chunks.md";
			await writeFile(
				join(vaultDir, notePath),
				[
					"````markdown",
					"x".repeat(24 * 1024),
					"```",
					"# Hidden after short fence",
					"`````",
					"# Visible after closing fence",
				].join("\n"),
			);

			await expect(
				service.getOutline(notePath, unauthorizedIdentity),
			).resolves.toEqual({
				notePath,
				outline: [
					{
						name: "Visible after closing fence",
						lineNumber: 6,
						outline: [],
					},
				],
			});
		});

		it("includes the final heading when the note has no trailing newline", async () => {
			const notePath = join(vaultDir, "no-trailing-newline.md");
			await writeFile(notePath, "Body text\n# Final heading");

			await expect(
				service.getOutline(
					"no-trailing-newline.md",
					unauthorizedIdentity,
				),
			).resolves.toEqual({
				notePath: relative(vaultDir, notePath).split(sep).join("/"),
				outline: [
					{ name: "Final heading", lineNumber: 2, outline: [] },
				],
			});
		});

		it("returns an empty title for a final H1 with closing hashes", async () => {
			const notePath = "empty-final-heading.md";
			await writeFile(join(vaultDir, notePath), "# ###");

			await expect(
				service.getOutline(notePath, unauthorizedIdentity),
			).resolves.toEqual({
				notePath,
				outline: [{ name: "", lineNumber: 1, outline: [] }],
			});
		});

		it("keeps a child under an empty H1 with closing hashes", async () => {
			const notePath = "empty-parent-heading.md";
			await writeFile(join(vaultDir, notePath), "# ###\n## Child\n");

			await expect(
				service.getOutline(notePath, unauthorizedIdentity),
			).resolves.toEqual({
				notePath,
				outline: [
					{
						name: "",
						lineNumber: 1,
						outline: [{ name: "Child", lineNumber: 2, outline: [] }],
					},
				],
			});
		});

		it("rejects when the note does not exist", async () => {
			await expect(
				service.getOutline("missing.md", unauthorizedIdentity),
			).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("allows only an authorized identity to outline a restricted note", async () => {
			const notePath = join(vaultDir, "restricted-outline.md");
			await writeFile(
				notePath,
				"---\nrestricted: true\n---\n# Private heading\n",
			);

			await expect(
				service.getOutline(
					"restricted-outline.md",
					unauthorizedIdentity,
				),
			).rejects.toThrow("Note is restricted");
			await expect(
				service.getOutline("restricted-outline.md", authorizedIdentity),
			).resolves.toMatchObject({
				outline: [
					{
						name: "Private heading",
						lineNumber: 4,
						outline: [],
					},
				],
			});
		});
	});
});
