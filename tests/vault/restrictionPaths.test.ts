import { createHash } from "node:crypto";
import {
	mkdtemp,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";
import { VaultService } from "../../src/vault/vault.service.ts";
import {
	authorizedIdentity,
	createRestrictedReaderEmails,
	unauthorizedIdentity as reader,
} from "../fixtures/identities.ts";

let root: string;
let vault: string;
let json: string;
const secret = "# Secret\nneedle private\n";
const version = createHash("sha256").update(secret).digest("hex");

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "restriction-paths-"));
	vault = join(root, "vault");
	json = join(root, "restrictions.json");
	await mkdir(join(vault, "Private", "Nested"), { recursive: true });
	await mkdir(join(vault, "Private-Archive"));
	await writeFile(join(vault, "Private", "Nested", "note.md"), secret);
	await writeFile(
		join(vault, "Private-Archive", "note.md"),
		"needle public\n",
	);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function service(vaultDir: string) {
	const logger = pino({ level: "silent" });
	return new VaultService(
		logger,
		vaultDir,
		new RestrictionsService(
			logger,
			json,
			createRestrictedReaderEmails(),
			vaultDir,
		),
	);
}

it.each([
	[false, "absolute-file"],
	[true, "absolute-file"],
	[false, "relative-file"],
	[true, "relative-file"],
	[false, "absolute-directory"],
	[true, "absolute-directory"],
	[false, "relative-directory"],
	[true, "relative-directory"],
] as const)(
	"enforces %s relative-vault / %s restrictions across all existing-note tools",
	async (relativeVault, format) => {
		const entry = {
			"absolute-file": join(vault, "Private", "Nested", "note.md"),
			"relative-file": "Private\\Nested/./note.md",
			"absolute-directory": join(vault, "Private"),
			"relative-directory": "Private\\",
		}[format];
		await writeFile(json, JSON.stringify([entry]));
		const svc = service(
			relativeVault ? relative(process.cwd(), vault) : vault,
		);
		const privatePath = "Private/Nested/note.md";
		const publicPath = "Private-Archive/note.md";
		expect((await svc.getNotes(0, 1, reader)).notes).toEqual([publicPath]);
		expect(
			(await svc.getNotePathByNoteName("note", 0, 1, reader)).paths,
		).toEqual([publicPath]);
		const search = await svc.searchNotes(
			"needle",
			false,
			true,
			0,
			1,
			reader,
		);
		expect(search.matches).toEqual([
			{ path: publicPath, line: 1, text: "needle public\n" },
		]);
		expect(search.pagination.hasMore).toBe(false);
		await expect(svc.readNote(privatePath, reader)).rejects.toThrow(
			"restricted",
		);
		await expect(
			svc.readNoteLines(privatePath, 1, 2, reader),
		).rejects.toThrow("restricted");
		await expect(svc.getOutline(privatePath, reader)).rejects.toThrow(
			"restricted",
		);
		await expect(
			svc.replaceNote(privatePath, "replacement", version, reader),
		).rejects.toThrow("restricted");
		await expect(
			svc.replaceNoteLines(
				privatePath,
				1,
				1,
				"replacement",
				version,
				reader,
			),
		).rejects.toThrow("restricted");
		await expect(
			svc.appendToNote(privatePath, "tail", version, reader),
		).rejects.toThrow("restricted");
		await expect(
			svc.beautifyNote(privatePath, "prefix", version, reader),
		).rejects.toThrow("restricted");
		expect(
			await readFile(join(vault, "Private", "Nested", "note.md"), "utf8"),
		).toBe(secret);
		expect(
			(await svc.readNote(privatePath, authorizedIdentity)).content,
		).toBe(secret);
		expect(
			(await svc.getNotes(0, 50, authorizedIdentity)).notes,
		).toHaveLength(2);
		expect(
			(
				await svc.searchNotes(
					"needle",
					false,
					true,
					0,
					50,
					authorizedIdentity,
				)
			).matches,
		).toHaveLength(2);
	},
);

it("restricts symlink aliases of private files and directories", async () => {
	await writeFile(json, JSON.stringify(["Private"]));
	await symlink(join(vault, "Private"), join(vault, "Alias"), "junction");
	await expect(
		service(vault).readNote("Alias/Nested/note.md", reader),
	).rejects.toThrow("restricted");
	await writeFile(json, JSON.stringify(["Alias"]));
	await expect(
		service(vault).readNote("Private/Nested/note.md", reader),
	).rejects.toThrow("restricted");
});

it("keeps absent directory entries effective when notes are later created", async () => {
	await writeFile(json, JSON.stringify(["Future/Nested"]));
	expect((await service(vault).getNotes(0, 50, reader)).notes).toHaveLength(
		2,
	);
	await mkdir(join(vault, "Future", "Nested"), { recursive: true });
	await writeFile(join(vault, "Future", "Nested", "new.md"), secret);
	await expect(
		service(vault).readNote("Future/Nested/new.md", reader),
	).rejects.toThrow("restricted");
});

it("blocks a path beneath a restricted directory even when its symlink target is public", async () => {
	await writeFile(json, JSON.stringify(["Private"]));
	await symlink(
		join(vault, "Private-Archive"),
		join(vault, "Private", "PublicAlias"),
		"junction",
	);
	await expect(
		service(vault).readNote("Private/PublicAlias/note.md", reader),
	).rejects.toThrow("restricted");
	expect(
		(await service(vault).readNote("Private-Archive/note.md", reader))
			.content,
	).toBe("needle public\n");
});
