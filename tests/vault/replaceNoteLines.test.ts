import { createHash } from "node:crypto";
import { promises, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";
import { VaultService } from "../../src/vault/vault.service.ts";

const { readStreamMock } = vi.hoisted(() => ({ readStreamMock: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	createReadStream: readStreamMock,
}));
const { createReadStream: realReadStream } =
	await vi.importActual<typeof import("node:fs")>("node:fs");

const digest = (content: string | Buffer) =>
	createHash("sha256").update(content).digest("hex");

describe("replaceNoteLines", () => {
	let testDir: string;
	let vaultDir: string;
	let notePath: string;
	let service: VaultService;
	let restrictions: RestrictionsService;

	beforeEach(async () => {
		readStreamMock.mockReset().mockImplementation(realReadStream);
		testDir = await promises.mkdtemp(join(tmpdir(), "obsidian-line-edit-"));
		vaultDir = join(testDir, "vault");
		await promises.mkdir(vaultDir);
		notePath = join(vaultDir, "note.md");
		const restrictedPaths = join(testDir, "restrictions.json");
		await promises.writeFile(restrictedPaths, "[]");
		const logger = pino({ level: "silent" });
		restrictions = new RestrictionsService(logger, restrictedPaths);
		service = new VaultService(logger, vaultDir, restrictions);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await promises.rm(testDir, { recursive: true, force: true });
	});

	it.each([
		[
			"one\ntwo\nthree\nfour\n",
			2,
			3,
			"new\nmore\nextra",
			"one\nnew\nmore\nextra\nfour\n",
		],
		["one\ntwo\nthree", 1, 1, "new", "new\ntwo\nthree"],
		["one\ntwo", 2, 2, "new", "one\nnew"],
		["one\ntwo\n", 2, 2, "new", "one\nnew\n"],
		["one\ntwo", 1, 2, "new\nmore", "new\nmore"],
		["one\ntwo\n", 1, 2, "new", "new\n"],
		["one\ntwo\nthree", 2, 2, "", "one\nthree"],
		["one\ntwo", 2, 2, "", "one\n"],
		["one\ntwo\n", 1, 2, "", ""],
		["one", 1, 1, "", ""],
		["one\n\nthree", 2, 2, "new", "one\nnew\nthree"],
		["\n", 1, 1, "new", "new\n"],
		["one\ntwo\nthree", 2, 2, "new\n", "one\nnew\nthree"],
		["one\ntwo\nthree", 2, 2, "\n", "one\n\nthree"],
		[
			"one\r\ntwo\r\nthree",
			2,
			2,
			"new\nmore",
			"one\r\nnew\r\nmore\r\nthree",
		],
		["one\r\ntwo\r\n", 2, 2, "new\r\n", "one\r\nnew\r\n"],
		["one\ntwo\n", 2, 2, "new\r\nmore", "one\nnew\nmore\n"],
	] as const)(
		"replaces inclusive lines in %j (%s-%s)",
		async (original, start, end, content, expected) => {
			await promises.writeFile(notePath, original);
			const version = (await service.readNoteLines("note.md", start, end))
				.version;
			await expect(
				service.replaceNoteLines(
					"note.md",
					start,
					end,
					content,
					version,
				),
			).resolves.toEqual({ ok: true });
			expect(await promises.readFile(notePath, "utf8")).toBe(expected);
			expect(await promises.readdir(vaultDir)).toEqual(["note.md"]);
		},
	);

	it("preserves bytes outside the range, including invalid UTF-8 and mixed newlines", async () => {
		const prefix = Buffer.from([0xff, 0x0d, 0x0a]);
		const suffix = Buffer.from([0xfe, 0x0a, 0x61]);
		const original = Buffer.concat([prefix, Buffer.from("old\n"), suffix]);
		await promises.writeFile(notePath, original);
		await service.replaceNoteLines(
			"note.md",
			2,
			2,
			"new",
			digest(original),
		);
		expect(await promises.readFile(notePath)).toEqual(
			Buffer.concat([prefix, Buffer.from("new\r\n"), suffix]),
		);
	});

	it("handles CRLF and UTF-8 split across chunks without accumulating long lines", async () => {
		const prefix = "x".repeat(64 * 1024 - 1) + "\r\n";
		const removed = "y".repeat(200_000) + "\r\n";
		const suffix = "z".repeat(3 * 64 * 1024 - 5) + "\u{1f600}\r\nlast";
		const original = prefix + removed + suffix;
		await promises.writeFile(notePath, original);
		await service.replaceNoteLines(
			"note.md",
			2,
			2,
			"\u{1f44b}\nnew",
			digest(original),
		);
		expect(await promises.readFile(notePath, "utf8")).toBe(
			prefix + "\u{1f44b}\r\nnew\r\n" + suffix,
		);
	});

	it("handles both edit boundaries at chunk edges", async () => {
		vi.spyOn(restrictions, "filterRestrictedNotes").mockImplementation(
			async (paths) => paths,
		);
		readStreamMock.mockImplementation((path, options) =>
			realReadStream(path, { ...options, highWaterMark: 1 }),
		);
		const original = "a\r\nb\r\nc\r\nd";
		await promises.writeFile(notePath, original);
		await service.replaceNoteLines(
			"note.md",
			2,
			3,
			"new",
			digest(original),
		);
		expect(await promises.readFile(notePath, "utf8")).toBe("a\r\nnew\r\nd");
	});

	it("rejects a stale hash caused by bytes after the edited range and removes the temporary file", async () => {
		const original = "one\ntwo\n" + "unchanged\n".repeat(20_000);
		const changed = original + "changed suffix";
		await promises.writeFile(notePath, changed);
		await expect(
			service.replaceNoteLines("note.md", 1, 1, "new", digest(original)),
		).rejects.toThrow("VERSION_CONFLICT");
		expect(await promises.readFile(notePath, "utf8")).toBe(changed);
		expect(await promises.readdir(vaultDir)).toEqual(["note.md"]);
	});

	it.each(["", "one", "one\n", "one\ntwo"])(
		"rejects ranges beyond EOF in %j without changing the note",
		async (original) => {
			await promises.writeFile(notePath, original);
			await expect(
				service.replaceNoteLines(
					"note.md",
					1,
					3,
					"new",
					digest(original),
				),
			).rejects.toBeInstanceOf(RangeError);
			expect(await promises.readFile(notePath, "utf8")).toBe(original);
			expect(await promises.readdir(vaultDir)).toEqual(["note.md"]);
		},
	);

	it.each([
		[0, 1],
		[-1, 2],
		[2, 1],
		[1.5, 2],
		[1, NaN],
		[1, Infinity],
		[1, Number.MAX_SAFE_INTEGER + 1],
	])(
		"rejects invalid range %s-%s before accessing the note",
		async (start, end) => {
			await expect(
				service.replaceNoteLines(
					"missing.md",
					start,
					end,
					"new",
					digest(""),
				),
			).rejects.toBeInstanceOf(RangeError);
		},
	);

	it("rejects malformed versions before accessing the note", async () => {
		await expect(
			service.replaceNoteLines("missing.md", 1, 1, "new", "invalid"),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("rejects a missing note when given a valid range and version", async () => {
		await expect(
			service.replaceNoteLines("missing.md", 1, 1, "new", digest("")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(await promises.readdir(vaultDir)).toEqual([]);
	});

	it("enforces vault boundaries and note restrictions", async () => {
		await promises.writeFile(join(testDir, "outside.md"), "secret");
		await expect(
			service.replaceNoteLines(
				"../outside.md",
				1,
				1,
				"new",
				digest("secret"),
			),
		).rejects.toThrow("Note path must be inside the vault");
		const original = "---\nrestricted: true\n---\nsecret\n";
		await promises.writeFile(notePath, original);
		await expect(
			service.replaceNoteLines("note.md", 4, 4, "new", digest(original)),
		).rejects.toThrow("Note is restricted");
		expect(await promises.readFile(notePath, "utf8")).toBe(original);
		expect(await promises.readdir(vaultDir)).toEqual(["note.md"]);
	});

	it("cleans up after a read failure and keeps the original", async () => {
		const original = "one\ntwo\nthree";
		await promises.writeFile(notePath, original);
		vi.spyOn(restrictions, "filterRestrictedNotes").mockImplementation(
			async (paths) => paths,
		);
		readStreamMock.mockImplementationOnce(() =>
			Readable.from(
				(async function* () {
					yield Buffer.from("one\n");
					throw new Error("read failed");
				})(),
			),
		);
		await expect(
			service.replaceNoteLines("note.md", 2, 2, "new", digest(original)),
		).rejects.toThrow("read failed");
		expect(await promises.readFile(notePath, "utf8")).toBe(original);
		expect(await promises.readdir(vaultDir)).toEqual(["note.md"]);
	});

	it("cleans up after an output failure and keeps the original", async () => {
		const original = "one\ntwo\nthree";
		await promises.writeFile(notePath, original);
		const realOpen = promises.open.bind(promises);
		vi.spyOn(promises, "open").mockImplementationOnce(async (...args) => {
			const handle = await realOpen(...args);
			vi.spyOn(handle, "createWriteStream").mockReturnValueOnce(
				new Writable({
					write(_chunk, _encoding, callback) {
						callback(new Error("write failed"));
					},
				}) as WriteStream,
			);
			return handle;
		});
		await expect(
			service.replaceNoteLines("note.md", 2, 2, "new", digest(original)),
		).rejects.toThrow("write failed");
		expect(await promises.readFile(notePath, "utf8")).toBe(original);
		expect(await promises.readdir(vaultDir)).toEqual(["note.md"]);
	});

	it("cleans up when the final rename fails", async () => {
		const original = "one\ntwo";
		await promises.writeFile(notePath, original);
		vi.spyOn(promises, "rename").mockRejectedValueOnce(
			new Error("rename failed"),
		);
		await expect(
			service.replaceNoteLines("note.md", 2, 2, "new", digest(original)),
		).rejects.toThrow("rename failed");
		expect(await promises.readFile(notePath, "utf8")).toBe(original);
		expect(await promises.readdir(vaultDir)).toEqual(["note.md"]);
	});

	it("detects an external edit after hashing but before commit", async () => {
		const original = "one\ntwo";
		const changed = "externally edited note";
		await promises.writeFile(notePath, original);
		const realChmod = promises.chmod.bind(promises);
		vi.spyOn(promises, "chmod").mockImplementationOnce(async (...args) => {
			await realChmod(...args);
			await promises.writeFile(notePath, changed);
		});
		await expect(
			service.replaceNoteLines("note.md", 2, 2, "new", digest(original)),
		).rejects.toThrow("VERSION_CONFLICT");
		expect(await promises.readFile(notePath, "utf8")).toBe(changed);
		expect(await promises.readdir(vaultDir)).toEqual(["note.md"]);
	});
});
