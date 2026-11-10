import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";
import { VaultService } from "../../src/vault/vault.service.ts";
import { resolveNotePath } from "../../src/vault/vault-paths.ts";
import { unauthorizedIdentity as identity } from "../fixtures/identities.ts";

let root: string;
let vault: string;
let service: VaultService;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "portable-paths-"));
	vault = join(root, "vault");
	await mkdir(join(vault, "Folder with spaces"), { recursive: true });
	await writeFile(
		join(vault, "Folder with spaces", "México.md"),
		"# Heading\nneedle\n",
	);
	const restrictions = join(root, "restrictions.json");
	await writeFile(restrictions, "[]");
	const logger = pino({ level: "silent" });
	service = new VaultService(
		logger,
		relative(process.cwd(), vault),
		new RestrictionsService(logger, restrictions, new Set(), vault),
	);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it("returns reusable forward-slash paths from every discovery and read tool", async () => {
	const expected = "Folder with spaces/México.md";
	const listed = await service.getNotes(0, 50, identity);
	const found = await service.getNotePathByNoteName(
		"México",
		0,
		50,
		identity,
	);
	const searched = await service.searchNotes(
		"needle",
		false,
		true,
		0,
		50,
		identity,
	);
	const read = await service.readNote(expected, identity);
	const lines = await service.readNoteLines(expected, 1, 1, identity);
	const outline = await service.getOutline(expected, identity);
	const paths = [
		...listed.notes,
		...found.paths,
		...searched.matches.map((match) => match.path),
		read.notePath,
		lines.notePath,
		outline.notePath,
	];
	expect(paths).toHaveLength(6);
	for (const path of paths) {
		expect(path).toBe(expected);
		expect((await service.readNote(path, identity)).content).toContain(
			"needle",
		);
	}
});

it("normalizes backslashes, mixed separators, and dot segments for reads and writes", async () => {
	const read = await service.readNote(
		"Folder with spaces\\.\\México.md",
		identity,
	);
	expect(read.notePath).toBe("Folder with spaces/México.md");
	await service.appendToNote(
		"Folder with spaces/../Folder with spaces\\México.md",
		"tail",
		read.version,
		identity,
	);
	await service.createNote("Folder with spaces\\new.md", "new");
	expect(
		(await service.readNote("Folder with spaces/new.md", identity)).content,
	).toBe("new");
});

it.each([
	"/etc/passwd",
	"C:\\vault\\note.md",
	"C:note.md",
	"\\\\server\\share\\note.md",
	"\\root\\note.md",
	"../note.md",
	"..\\note.md",
	"",
	"bad\0.md",
])("rejects non-relative or escaping tool path %j", (path) => {
	expect(() => resolveNotePath(vault, path)).toThrow();
});

it("uses the canonical vault root when the configured vault is a directory symlink", async () => {
	const alias = join(root, "alias");
	await symlink(vault, alias, "junction");
	const logger = pino({ level: "silent" });
	const linked = new VaultService(
		logger,
		alias,
		new RestrictionsService(
			logger,
			join(root, "restrictions.json"),
			new Set(),
			vault,
		),
	);
	expect((await linked.getNotes(0, 50, identity)).notes).toEqual([
		"Folder with spaces/México.md",
	]);
});
