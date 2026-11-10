import { createHash } from "node:crypto";
import {
	access,
	mkdtemp,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";
import { VaultService } from "../../src/vault/vault.service.ts";
import {
	authorizedIdentity,
	createRestrictedReaderEmails,
	unauthorizedIdentity,
} from "../fixtures/identities.ts";

const digest = (content: string | Buffer) =>
	createHash("sha256").update(content).digest("hex");

describe("VaultService note mutations", () => {
	let testDir: string;
	let vaultDir: string;
	let service: VaultService;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "obsidian-mutations-"));
		vaultDir = join(testDir, "vault");
		await mkdir(vaultDir);
		const restrictedPaths = join(testDir, "restrictions.json");
		await writeFile(restrictedPaths, "[]");
		const logger = pino({ level: "silent" });
		service = new VaultService(
			logger,
			vaultDir,
			new RestrictionsService(
				logger,
				restrictedPaths,
				createRestrictedReaderEmails(),
				vaultDir,
			),
		);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	describe("createNote", () => {
		it("creates a note with the exact requested contents", async () => {
			const content = "# H\u00e9llo\n\nNew note \u{1f44b}\n";

			await expect(
				service.createNote("created.md", content),
			).resolves.toEqual({ ok: true });
			await expect(
				readFile(join(vaultDir, "created.md"), "utf8"),
			).resolves.toBe(content);
		});

		it("creates a note in an existing nested directory", async () => {
			await mkdir(join(vaultDir, "folder"));

			await expect(
				service.createNote("folder/nested.md", "nested"),
			).resolves.toEqual({ ok: true });
			await expect(
				readFile(join(vaultDir, "folder", "nested.md"), "utf8"),
			).resolves.toBe("nested");
		});

		it("refuses to overwrite an existing note and preserves it", async () => {
			const notePath = join(vaultDir, "existing.md");
			await writeFile(notePath, "original");

			await expect(
				service.createNote("existing.md", "replacement"),
			).rejects.toThrow("That note already exists");
			await expect(readFile(notePath, "utf8")).resolves.toBe("original");
		});

		it("rejects creation when the parent directory does not exist", async () => {
			await expect(
				service.createNote("missing/folder/note.md", "content"),
			).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("rejects traversal outside the vault", async () => {
			const outsidePath = join(testDir, "outside.md");

			await expect(
				service.createNote("../outside.md", "must not be created"),
			).rejects.toThrow("Note path must be inside the vault");
			await expect(access(outsidePath)).rejects.toMatchObject({
				code: "ENOENT",
			});
		});
	});

	describe("replaceNote", () => {
		it("replaces the complete note when the expected version matches", async () => {
			const notePath = join(vaultDir, "replace.md");
			const original = "old\n".repeat(4_000);
			const replacement = "# Replaced\n\nNew UTF-8 contents \u{1f680}";
			await writeFile(notePath, original);

			await expect(
				service.replaceNote(
					"replace.md",
					replacement,
					digest(original),
					unauthorizedIdentity,
				),
			).resolves.toEqual({ ok: true });
			await expect(readFile(notePath, "utf8")).resolves.toBe(replacement);
		});

		it("supports replacing a note with empty content", async () => {
			const notePath = join(vaultDir, "empty.md");
			const original = "remove me";
			await writeFile(notePath, original);

			await expect(
				service.replaceNote(
					"empty.md",
					"",
					digest(original),
					unauthorizedIdentity,
				),
			).resolves.toEqual({ ok: true });
			await expect(readFile(notePath, "utf8")).resolves.toBe("");
		});

		it("rejects a stale version without modifying the note", async () => {
			const notePath = join(vaultDir, "stale.md");
			const current = "current contents";
			await writeFile(notePath, current);

			await expect(
				service.replaceNote(
					"stale.md",
					"replacement",
					digest("old contents"),
					unauthorizedIdentity,
				),
			).rejects.toThrow("VERSION_CONFLICT");
			await expect(readFile(notePath, "utf8")).resolves.toBe(current);
		});

		it("rejects when the note does not exist", async () => {
			await expect(
				service.replaceNote(
					"missing.md",
					"replacement",
					digest(""),
					unauthorizedIdentity,
				),
			).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("rejects a restricted note without modifying it", async () => {
			const notePath = join(vaultDir, "restricted.md");
			const original = "---\nrestricted: true\n---\n# Private\n";
			await writeFile(notePath, original);

			await expect(
				service.replaceNote(
					"restricted.md",
					"replacement",
					digest(original),
					unauthorizedIdentity,
				),
			).rejects.toThrow("Note is restricted");
			await expect(readFile(notePath, "utf8")).resolves.toBe(original);

			await expect(
				service.replaceNote(
					"restricted.md",
					"authorized replacement",
					digest(original),
					authorizedIdentity,
				),
			).resolves.toEqual({ ok: true });
			await expect(readFile(notePath, "utf8")).resolves.toBe(
				"authorized replacement",
			);
		});

		it("rejects traversal outside the vault without modifying the file", async () => {
			const outsidePath = join(testDir, "outside-replace.md");
			const original = "outside";
			await writeFile(outsidePath, original);

			await expect(
				service.replaceNote(
					"../outside-replace.md",
					"replacement",
					digest(original),
					unauthorizedIdentity,
				),
			).rejects.toThrow("Note path must be inside the vault");
			await expect(readFile(outsidePath, "utf8")).resolves.toBe(original);
		});
	});

	describe("beautifyNote", () => {
		it("prepends content while preserving the complete original note", async () => {
			const notePath = join(vaultDir, "beautify.md");
			const original = "# Existing note\n\nBody \u{1f44b}\n";
			const prefix = "---\ntags: [organized]\n---\n";
			await writeFile(notePath, original);

			await expect(
				service.beautifyNote(
					"beautify.md",
					prefix,
					digest(original),
					unauthorizedIdentity,
				),
			).resolves.toEqual({ ok: true });
			await expect(readFile(notePath, "utf8")).resolves.toBe(
				prefix + original,
			);
		});

		it("allows empty beautification content without changing the note", async () => {
			const notePath = join(vaultDir, "unchanged.md");
			const original = "unchanged";
			await writeFile(notePath, original);

			await expect(
				service.beautifyNote(
					"unchanged.md",
					"",
					digest(original),
					unauthorizedIdentity,
				),
			).resolves.toEqual({ ok: true });
			await expect(readFile(notePath, "utf8")).resolves.toBe(original);
		});

		it("rejects a stale version without modifying the note", async () => {
			const notePath = join(vaultDir, "stale-beautify.md");
			const original = "current";
			await writeFile(notePath, original);

			await expect(
				service.beautifyNote(
					"stale-beautify.md",
					"prefix",
					digest("old"),
					unauthorizedIdentity,
				),
			).rejects.toThrow("VERSION_CONFLICT");
			await expect(readFile(notePath, "utf8")).resolves.toBe(original);
		});

		it("rejects when the note does not exist", async () => {
			await expect(
				service.beautifyNote(
					"missing.md",
					"prefix",
					digest(""),
					unauthorizedIdentity,
				),
			).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("rejects a restricted note without modifying it", async () => {
			const notePath = join(vaultDir, "restricted-beautify.md");
			const original = "---\nrestricted: true\n---\n# Private\n";
			await writeFile(notePath, original);

			await expect(
				service.beautifyNote(
					"restricted-beautify.md",
					"prefix",
					digest(original),
					unauthorizedIdentity,
				),
			).rejects.toThrow("Note is restricted");
			await expect(readFile(notePath, "utf8")).resolves.toBe(original);

			await expect(
				service.beautifyNote(
					"restricted-beautify.md",
					"authorized prefix\n",
					digest(original),
					authorizedIdentity,
				),
			).resolves.toEqual({ ok: true });
			await expect(readFile(notePath, "utf8")).resolves.toBe(
				`authorized prefix\n${original}`,
			);
		});

		it("rejects traversal outside the vault without modifying the file", async () => {
			const outsidePath = join(testDir, "outside-beautify.md");
			const original = "outside";
			await writeFile(outsidePath, original);

			await expect(
				service.beautifyNote(
					"../outside-beautify.md",
					"prefix",
					digest(original),
					unauthorizedIdentity,
				),
			).rejects.toThrow("Note path must be inside the vault");
			await expect(readFile(outsidePath, "utf8")).resolves.toBe(original);
		});
	});
});
