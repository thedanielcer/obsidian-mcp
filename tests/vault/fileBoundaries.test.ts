import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, expect, it } from "vitest";
import { VaultService } from "../../src/vault/vault.service.ts";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";
import { unauthorizedIdentity as identity } from "../fixtures/identities.ts";

let root: string;
let vault: string;
let service: VaultService;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "file-boundaries-"));
	vault = join(root, "vault");
	await mkdir(vault);
	const json = join(root, "restrictions.json");
	await writeFile(json, "[]");
	const logger = pino({ level: "silent" });
	service = new VaultService(
		logger,
		vault,
		new RestrictionsService(logger, json, new Set(), vault),
	);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it("rejects creation through an outside directory symlink without creating a file", async () => {
	const outside = join(root, "outside");
	await mkdir(outside);
	await symlink(outside, join(vault, "link"), "junction");
	await expect(service.createNote("link/new.md", "content", identity)).rejects.toThrow(
		"inside the vault",
	);
	expect(await readdir(outside)).toEqual([]);
});

it("allows creation through a directory symlink whose target is an ordinary vault directory", async () => {
	await mkdir(join(vault, "notes"));
	await symlink(join(vault, "notes"), join(vault, "alias"), "junction");
	await service.createNote("alias/new.md", "content", identity);
	await expect(
		service.createNote("alias/new.md", "overwrite", identity),
	).rejects.toThrow("already exists");
	expect(await readFile(join(vault, "notes", "new.md"), "utf8")).toBe(
		"content",
	);
});

it.each([
	"settings.json",
	"attachment.png",
	".obsidian/settings.md",
	".git/settings.md",
	"nested/.obsidian/settings.md",
])("rejects all direct note operations on %s", async (path) => {
	const nativePath = join(vault, path);
	await mkdir(join(nativePath, ".."), { recursive: true });
	await writeFile(nativePath, "original");
	const hash = "a".repeat(64);
	const calls = [
		() => service.createNote(path, "new", identity),
		() => service.readNote(path, identity),
		() => service.readNoteLines(path, 1, 1, identity),
		() => service.getOutline(path, identity),
		() => service.replaceNote(path, "new", hash, identity),
		() => service.replaceNoteLines(path, 1, 1, "new", hash, identity),
		() => service.appendToNote(path, "new", hash, identity),
		() => service.beautifyNote(path, "new", hash, identity),
	];
	for (const call of calls) await expect(call()).rejects.toThrow("Markdown");
	expect(await readFile(nativePath, "utf8")).toBe("original");
});

it("excludes internal Markdown files before discovery pagination", async () => {
	for (const dir of [".obsidian", ".git", "nested/.obsidian"]) {
		await mkdir(join(vault, dir), { recursive: true });
		await writeFile(join(vault, dir, "note.md"), "needle internal");
	}
	await writeFile(join(vault, "note.md"), "needle public\n");
	expect((await service.getNotes(0, 1, identity)).notes).toEqual(["note.md"]);
	expect(
		(await service.getNotePathByNoteName("note", 0, 1, identity)).paths,
	).toEqual(["note.md"]);
	expect(
		(await service.searchNotes("needle", false, true, 0, 1, identity))
			.matches,
	).toEqual([{ path: "note.md", line: 1, text: "needle public\n" }]);
});

it("checks symlink targets for internal directories and non-Markdown files", async () => {
	await mkdir(join(vault, ".obsidian"));
	await writeFile(join(vault, ".obsidian", "hidden.md"), "private");
	await writeFile(join(vault, "settings.json"), "private");
	await symlink(join(vault, ".obsidian"), join(vault, "alias"), "junction");
	await symlink(
		join(vault, "settings.json"),
		join(vault, "disguised.md"),
		"file",
	);
	await expect(service.readNote("alias/hidden.md", identity)).rejects.toThrow(
		"Markdown",
	);
	await expect(service.readNote("disguised.md", identity)).rejects.toThrow(
		"Markdown",
	);
	await expect(service.createNote("alias/new.md", "new", identity)).rejects.toThrow(
		"Markdown",
	);
});

it("rejects a directory named with an .md extension", async () => {
	await mkdir(join(vault, "folder.md"));
	await expect(service.readNote("folder.md", identity)).rejects.toThrow(
		"regular file",
	);
});
