import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";
import { VaultService } from "../../src/vault/vault.service.ts";
import {
	authorizedIdentity,
	createRestrictedReaderEmails,
	unauthorizedIdentity,
} from "../fixtures/identities.ts";

describe("getNotePathByNoteName", () => {
	let testDir: string;
	let vaultDir: string;
	let restrictedPaths: string;
	let service: VaultService;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "obsidian-note-paths-"));
		vaultDir = join(testDir, "vault");
		await mkdir(vaultDir);
		restrictedPaths = join(testDir, "restrictions.json");
		await writeFile(restrictedPaths, "[]");
		const logger = pino({ level: "silent" });
		service = new VaultService(
			logger,
			vaultDir,
			new RestrictionsService(
				logger,
				restrictedPaths,
				createRestrictedReaderEmails(),
			),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(testDir, { recursive: true, force: true });
	});

	it("returns matching Markdown paths recursively in sorted order", async () => {
		await mkdir(join(vaultDir, "nested"));
		await Promise.all([
			writeFile(join(vaultDir, "project.md"), "root"),
			writeFile(join(vaultDir, "nested", "project-plan.md"), "nested"),
			writeFile(join(vaultDir, "other.md"), "other"),
			writeFile(join(vaultDir, "project.txt"), "not Markdown"),
		]);

		await expect(
			service.getNotePathByNoteName(
				"project",
				0,
				10,
				unauthorizedIdentity,
			),
		).resolves.toEqual({
			paths: ["nested/project-plan.md", "project.md"],
			pagination: { skip: 0, limit: 10, hasMore: false, nextSkip: 2 },
		});
	});

	it("filters frontmatter and JSON restrictions before paginating", async () => {
		const restrictedByFrontmatter = join(vaultDir, "match-01.md");
		const restrictedByJson = join(vaultDir, "match-02.md");
		await Promise.all([
			writeFile(
				restrictedByFrontmatter,
				"---\nrestricted: true\n---\nprivate",
			),
			writeFile(restrictedByJson, "private"),
			writeFile(join(vaultDir, "match-03.md"), "public"),
			writeFile(join(vaultDir, "match-04.md"), "public"),
			writeFile(join(vaultDir, "match-05.md"), "public"),
		]);
		await writeFile(restrictedPaths, JSON.stringify([restrictedByJson]));

		const first = await service.getNotePathByNoteName(
			"match",
			0,
			2,
			unauthorizedIdentity,
		);
		const second = await service.getNotePathByNoteName(
			"match",
			first.pagination.nextSkip,
			2,
			unauthorizedIdentity,
		);

		expect(first).toEqual({
			paths: ["match-03.md", "match-04.md"],
			pagination: { skip: 0, limit: 2, hasMore: true, nextSkip: 2 },
		});
		expect(second).toEqual({
			paths: ["match-05.md"],
			pagination: { skip: 2, limit: 2, hasMore: false, nextSkip: 3 },
		});

		await expect(
			service.getNotePathByNoteName("match", 0, 10, authorizedIdentity),
		).resolves.toEqual({
			paths: [
				"match-01.md",
				"match-02.md",
				"match-03.md",
				"match-04.md",
				"match-05.md",
			],
			pagination: { skip: 0, limit: 10, hasMore: false, nextSkip: 5 },
		});
	});

	it("returns empty pagination metadata when no filenames match", async () => {
		await writeFile(join(vaultDir, "other.md"), "content");

		await expect(
			service.getNotePathByNoteName(
				"missing",
				3,
				2,
				unauthorizedIdentity,
			),
		).resolves.toEqual({
			paths: [],
			pagination: { skip: 3, limit: 2, hasMore: false, nextSkip: 3 },
		});
	});

	it("returns an empty page when skip exceeds the available matches", async () => {
		await writeFile(join(vaultDir, "match.md"), "content");

		await expect(
			service.getNotePathByNoteName("match", 5, 2, unauthorizedIdentity),
		).resolves.toEqual({
			paths: [],
			pagination: { skip: 5, limit: 2, hasMore: false, nextSkip: 5 },
		});
	});

	it("supports names beginning with a dash without treating them as options", async () => {
		await writeFile(join(vaultDir, "my-draft.md"), "content");

		await expect(
			service.getNotePathByNoteName(
				"-draft",
				0,
				10,
				unauthorizedIdentity,
			),
		).resolves.toMatchObject({ paths: ["my-draft.md"] });
	});

	it.each([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid skip %s before searching", async (skip) => {
		const filenameSearch = vi.fn();
		Object.assign(service, { execFileAsync: filenameSearch });

		await expect(
			service.getNotePathByNoteName(
				"match",
				skip,
				10,
				unauthorizedIdentity,
			),
		).rejects.toBeInstanceOf(RangeError);
		expect(filenameSearch).not.toHaveBeenCalled();
	});

	it.each([
		0,
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid limit %s before searching", async (limit) => {
		const filenameSearch = vi.fn();
		Object.assign(service, { execFileAsync: filenameSearch });

		await expect(
			service.getNotePathByNoteName(
				"match",
				0,
				limit,
				unauthorizedIdentity,
			),
		).rejects.toBeInstanceOf(RangeError);
		expect(filenameSearch).not.toHaveBeenCalled();
	});

	it("rejects a pagination window beyond safe integer precision", async () => {
		await expect(
			service.getNotePathByNoteName(
				"match",
				Number.MAX_SAFE_INTEGER,
				1,
				unauthorizedIdentity,
			),
		).rejects.toBeInstanceOf(RangeError);
	});

	it("propagates an unexpected ripgrep failure", async () => {
		const error = Object.assign(new Error("ripgrep unavailable"), {
			code: "ENOENT",
		});
		Object.assign(service, {
			execFileAsync: vi.fn().mockRejectedValue(error),
		});

		await expect(
			service.getNotePathByNoteName("match", 0, 10, unauthorizedIdentity),
		).rejects.toBe(error);
	});

	it("handles a successful search with empty stdout", async () => {
		Object.assign(service, {
			execFileAsync: vi.fn().mockResolvedValue({ stdout: "" }),
		});

		await expect(
			service.getNotePathByNoteName("match", 0, 10, unauthorizedIdentity),
		).resolves.toEqual({
			paths: [],
			pagination: { skip: 0, limit: 10, hasMore: false, nextSkip: 0 },
		});
	});
});
