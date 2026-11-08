import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import pino from "pino";
import pretty from "pino-pretty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultService } from "../../src/vault/vault.service.ts";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";

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
		restrictionsService = new RestrictionsService(logger, restrictedPaths);
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

			await expect(service.getNotes()).resolves.toEqual({
				notes: ["a.md", "b.md", join("folder", "c.md")],
				pagination: {
					skip: 0,
					limit: 50,
					hasMore: false,
					nextSkip: 3,
				},
			});
		});

		it("returns an empty list for an empty vault", async () => {
			await expect(service.getNotes()).resolves.toEqual({
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

			const first = await service.getNotes(0, 2);
			expect(first).toEqual({
				notes: ["01.md", "02.md"],
				pagination: {
					skip: 0,
					limit: 2,
					hasMore: true,
					nextSkip: 2,
				},
			});
			const second = await service.getNotes(first.pagination.nextSkip, 2);
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
				service.getNotes(second.pagination.nextSkip, 2),
			).resolves.toEqual({
				notes: ["05.md"],
				pagination: {
					skip: 4,
					limit: 2,
					hasMore: false,
					nextSkip: 5,
				},
			});
			await expect(service.getNotes(6, 2)).resolves.toEqual({
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

			await expect(service.getNotes(0, 1)).resolves.toEqual({
				notes: ["02.md"],
				pagination: {
					skip: 0,
					limit: 1,
					hasMore: true,
					nextSkip: 1,
				},
			});
			await expect(service.getNotes(1, 1)).resolves.toEqual({
				notes: ["03.md"],
				pagination: {
					skip: 1,
					limit: 1,
					hasMore: false,
					nextSkip: 2,
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
			await expect(service.getNotes(skip, 10)).rejects.toBeInstanceOf(
				RangeError,
			);
		});

		it.each([
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		])("rejects invalid limit value %s", async (limit) => {
			await expect(service.getNotes(0, limit)).rejects.toBeInstanceOf(
				RangeError,
			);
		});

		it("rejects a pagination window beyond safe integer precision", async () => {
			await expect(
				service.getNotes(Number.MAX_SAFE_INTEGER, 1),
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
				service.readNote(join("folder", "note.md")),
			).resolves.toEqual({
				notePath: await realpath(notePath),
				content: expected,
				version: createHash("sha256").update(expected).digest("hex"),
			});
		});

		it("reads a note at the 65,536-byte limit", async () => {
			const notePath = join(vaultDir, "limit.md");
			const expected = Buffer.alloc(65_536, "a");
			await writeFile(notePath, expected);

			const result = await service.readNote("limit.md");

			expect(Buffer.byteLength(result.content)).toBe(65_536);
			expect(result.notePath).toBe(await realpath(notePath));
			expect(result.version).toBe(
				createHash("sha256").update(expected).digest("hex"),
			);
		});

		it("rejects a note larger than 65,536 bytes", async () => {
			await writeFile(
				join(vaultDir, "too-large.md"),
				Buffer.alloc(65_537, "a"),
			);

			await expect(service.readNote("too-large.md")).rejects.toThrow(
				/NOTE_TOO_LARGE: This note is 65537 bytes/,
			);
		});

		it("rejects traversal to an existing file outside the vault", async () => {
			await writeFile(join(testDir, "outside.md"), "secret");

			await expect(service.readNote("../outside.md")).rejects.toThrow(
				"Note path must be inside the vault",
			);
		});

		it("rejects an absolute path outside the vault", async () => {
			const outsidePath = join(testDir, "outside.md");
			await writeFile(outsidePath, "secret");
			expect(isAbsolute(outsidePath)).toBe(true);

			await expect(service.readNote(outsidePath)).rejects.toThrow();
		});

		it("rejects a missing note", async () => {
			await expect(service.readNote("missing.md")).rejects.toThrow();
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
					"## Child",
					"### Grandchild",
					"## Second child",
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

			await expect(service.getOutline("nested.md")).resolves.toEqual({
				notePath: await realpath(notePath),
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
								outline: [],
							},
						],
					},
					{
						name: "Second parent",
						lineNumber: 10,
						outline: [
							{
								name: "Child to second parent",
								lineNumber: 11,
								outline: [
									{
										name: "Grandchild to child of second parent",
										lineNumber: 12,
										outline: [],
									},
								],
							},
							{
								name: "Second child to second parent",
								lineNumber: 13,
								outline: [
									{
										name: "Grandchild to second child of second parent",
										lineNumber: 14,
										outline: [],
									},
								],
							},
						],
					},
					{
						name: "Third parent",
						lineNumber: 15,
						outline: [
							{
								name: "Child to third parent",
								lineNumber: 16,
								outline: [
									{
										name: "Grandchild to child to third parent",
										lineNumber: 21,
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
				service.getOutline("starts-at-level-two.md"),
			).resolves.toEqual({
				notePath: await realpath(notePath),
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

		it("attaches a skipped heading level to the nearest available parent", async () => {
			const notePath = join(vaultDir, "skipped-level.md");
			await writeFile(notePath, "# Parent\n### Level three child");

			await expect(
				service.getOutline("skipped-level.md"),
			).resolves.toEqual({
				notePath: await realpath(notePath),
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

		it("includes the final heading when the note has no trailing newline", async () => {
			const notePath = join(vaultDir, "no-trailing-newline.md");
			await writeFile(notePath, "Body text\n# Final heading");

			await expect(
				service.getOutline("no-trailing-newline.md"),
			).resolves.toEqual({
				notePath: await realpath(notePath),
				outline: [
					{ name: "Final heading", lineNumber: 2, outline: [] },
				],
			});
		});
	});
});
