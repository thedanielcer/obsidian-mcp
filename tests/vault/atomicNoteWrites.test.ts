import { createHash } from "node:crypto";
import { promises, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeNoteAtomically } from "../../src/vault/atomic-note-write.ts";

const { readStreamMock } = vi.hoisted(() => ({ readStreamMock: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	createReadStream: readStreamMock,
}));
const { createReadStream: realReadStream } =
	await vi.importActual<typeof import("node:fs")>("node:fs");
const digest = (content: string | Buffer) =>
	createHash("sha256").update(content).digest("hex");

describe.each(["replace", "prepend"] as const)(
	"%s atomic writes",
	(operation) => {
		let root: string;
		let path: string;
		const original = "# Original\n" + "body\r\n".repeat(20_000);

		beforeEach(async () => {
			readStreamMock.mockReset().mockImplementation(realReadStream);
			root = await promises.mkdtemp(join(tmpdir(), "atomic-note-"));
			path = join(root, "note.md");
			await promises.writeFile(path, original);
		});
		afterEach(async () => {
			vi.restoreAllMocks();
			await promises.rm(root, { recursive: true, force: true });
		});
		const edit = () =>
			writeNoteAtomically(path, "New 👋\n", digest(original), operation);
		async function unchanged() {
			expect(await promises.readFile(path, "utf8")).toBe(original);
			expect(await promises.readdir(root)).toEqual(["note.md"]);
		}

		it("commits exact content and preserves permission bits", async () => {
			await promises.chmod(path, 0o640);
			await expect(edit()).resolves.toBeUndefined();
			expect(await promises.readFile(path, "utf8")).toBe(
				"New 👋\n" + (operation === "prepend" ? original : ""),
			);
			if (process.platform !== "win32")
				expect((await promises.stat(path)).mode & 0o777).toBe(0o640);
			expect(await promises.readdir(root)).toEqual(["note.md"]);
		});
		it("preserves the original and cleans up after a stale hash", async () => {
			await expect(
				writeNoteAtomically(path, "new", digest("stale"), operation),
			).rejects.toThrow("VERSION_CONFLICT");
			await unchanged();
		});
		it("preserves the original and cleans up after a source read failure", async () => {
			readStreamMock.mockImplementationOnce(() =>
				Readable.from(
					(async function* () {
						yield Buffer.from("partial");
						throw new Error("read failed");
					})(),
				),
			);
			await expect(edit()).rejects.toThrow("read failed");
			await unchanged();
		});
		it("preserves the original and cleans up after a partial output write fails", async () => {
			const realOpen = promises.open.bind(promises);
			vi.spyOn(promises, "open").mockImplementationOnce(
				async (...args) => {
					const handle = await realOpen(...args);
					vi.spyOn(handle, "createWriteStream").mockReturnValueOnce(
						new Writable({
							write(chunk, _encoding, callback) {
								handle
									.write(chunk)
									.then(
										() =>
											callback(new Error("write failed")),
										callback,
									);
							},
						}) as WriteStream,
					);
					return handle;
				},
			);
			await expect(edit()).rejects.toThrow("write failed");
			await unchanged();
		});
		it("preserves the original and cleans up when rename fails", async () => {
			vi.spyOn(promises, "rename").mockRejectedValueOnce(
				new Error("rename failed"),
			);
			await expect(edit()).rejects.toThrow("rename failed");
			await unchanged();
		});
		it("retains an external change detected before commit", async () => {
			const realChmod = promises.chmod.bind(promises);
			vi.spyOn(promises, "chmod").mockImplementationOnce(
				async (...args) => {
					await realChmod(...args);
					await promises.writeFile(path, "External edit");
				},
			);
			await expect(edit()).rejects.toThrow("VERSION_CONFLICT");
			expect(await promises.readFile(path, "utf8")).toBe("External edit");
			expect(await promises.readdir(root)).toEqual(["note.md"]);
		});
		it("leaves the note intact if creating the temporary file fails", async () => {
			vi.spyOn(promises, "open").mockRejectedValueOnce(
				new Error("open failed"),
			);
			await expect(edit()).rejects.toThrow("open failed");
			await unchanged();
		});
	},
);
