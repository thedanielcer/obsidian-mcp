import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultService } from "../../src/vault/vault.service.ts";

describe("VaultService", () => {
	let testDir: string;
	let vaultDir: string;
	let service: VaultService;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "obsidian-mcp-"));
		vaultDir = join(testDir, "vault");
		await mkdir(vaultDir);
		service = new VaultService(
			vaultDir,
			pino({ level: process.env.TEST_LOG_LEVEL ?? "silent" }),
		);
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

			await expect(service.getNotes()).resolves.toEqual([
				"a.md",
				"b.md",
				join("folder", "c.md"),
			]);
		});

		it("returns an empty list for an empty vault", async () => {
			await expect(service.getNotes()).resolves.toEqual([]);
		});

		it("paginates the sorted note list", async () => {
			await Promise.all(
				["01.md", "02.md", "03.md", "04.md", "05.md"].map((name) =>
					writeFile(join(vaultDir, name), name),
				),
			);

			await expect(service.getNotes(2, 2)).resolves.toEqual([
				"03.md",
				"04.md",
			]);
			await expect(service.getNotes(4, 2)).resolves.toEqual([]);
		});

		it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
			"rejects invalid page value %s",
			async (page) => {
				await expect(service.getNotes(page, 10)).rejects.toThrow(
					new RangeError(
						"page and pageSize must be positive integers",
					),
				);
			},
		);

		it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
			"rejects invalid page-size value %s",
			async (pageSize) => {
				await expect(service.getNotes(1, pageSize)).rejects.toThrow(
					new RangeError(
						"page and pageSize must be positive integers",
					),
				);
			},
		);
	});

	describe("readNote", () => {
		it("reads a nested UTF-8 Markdown note", async () => {
			await mkdir(join(vaultDir, "folder"));
			const expected = "# H\u00e9llo\n\nA note \u{1f44b}";
			await writeFile(join(vaultDir, "folder", "note.md"), expected);

			await expect(
				service.readNote(join("folder", "note.md")),
			).resolves.toBe(expected);
		});

		it("reads a note at the 65,536-byte limit", async () => {
			await writeFile(
				join(vaultDir, "limit.md"),
				Buffer.alloc(65_536, "a"),
			);

			const contents = await service.readNote("limit.md");

			expect(Buffer.byteLength(contents)).toBe(65_536);
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
					"# Parent",
					"Some body text",
					"## Child",
					"### Grandchild",
					"## Second child",
					"# Second parent",
				].join("\n"),
			);

			await expect(service.getOutline("nested.md")).resolves.toEqual({
				notePath: await realpath(notePath),
				outline: [
					{
						name: "Parent",
						outline: [
							{
								name: "Child",
								outline: [{ name: "Grandchild", outline: [] }],
							},
							{ name: "Second child", outline: [] },
						],
					},
					{ name: "Second parent", outline: [] },
				],
			});
		});

		it("promotes a second-level heading when the note starts at level two", async () => {
			const notePath = join(vaultDir, "starts-at-level-two.md");
			await writeFile(
				notePath,
				"## Starts at level two\n### Nested below it",
			);

			await expect(
				service.getOutline("starts-at-level-two.md"),
			).resolves.toEqual({
				notePath: await realpath(notePath),
				outline: [
					{
						name: "Starts at level two",
						outline: [{ name: "Nested below it", outline: [] }],
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
						outline: [{ name: "Level three child", outline: [] }],
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
				outline: [{ name: "Final heading", outline: [] }],
			});
		});
	});
});
