import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("searchNotes pagination with ripgrep", () => {
	let vaultDir: string;
	let restrictedPaths: string;
	let service: VaultService;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "obsidian-search-pagination-"));
		restrictedPaths = join(vaultDir, "restrictions.json");
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
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("paginates across sorted files without duplicates or consuming the lookahead", async () => {
		await writeFile(
			join(vaultDir, "b.md"),
			"needle b1\nneedle b2\nneedle b3\n",
		);
		await writeFile(join(vaultDir, "a.md"), "needle a1\nneedle a2\n");

		const first = await service.searchNotes(
			"needle",
			false,
			true,
			0,
			2,
			unauthorizedIdentity,
		);
		const second = await service.searchNotes(
			"needle",
			false,
			true,
			first.pagination.nextSkip,
			2,
			unauthorizedIdentity,
		);
		const third = await service.searchNotes(
			"needle",
			false,
			true,
			second.pagination.nextSkip,
			2,
			unauthorizedIdentity,
		);

		expect(first.pagination).toEqual({
			skip: 0,
			limit: 2,
			hasMore: true,
			nextSkip: 2,
		});
		expect(second.pagination).toEqual({
			skip: 2,
			limit: 2,
			hasMore: true,
			nextSkip: 4,
		});
		expect(third.pagination).toEqual({
			skip: 4,
			limit: 2,
			hasMore: false,
			nextSkip: 5,
		});
		expect([...first.matches, ...second.matches, ...third.matches]).toEqual(
			[
				{ path: "a.md", line: 1, text: "needle a1\n" },
				{ path: "a.md", line: 2, text: "needle a2\n" },
				{ path: "b.md", line: 1, text: "needle b1\n" },
				{ path: "b.md", line: 2, text: "needle b2\n" },
				{ path: "b.md", line: 3, text: "needle b3\n" },
			],
		);
	});

	it("reports no more results when the final page is exactly full", async () => {
		await writeFile(join(vaultDir, "a.md"), "needle\nneedle\n");

		const result = await service.searchNotes(
			"needle",
			false,
			true,
			0,
			2,
			unauthorizedIdentity,
		);
		expect(result.matches).toHaveLength(2);
		expect(result.pagination).toEqual({
			skip: 0,
			limit: 2,
			hasMore: false,
			nextSkip: 2,
		});
	});

	it("returns pagination metadata when the query has no matches", async () => {
		await writeFile(join(vaultDir, "a.md"), "other content\n");

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				3,
				2,
				unauthorizedIdentity,
			),
		).resolves.toEqual({
			matches: [],
			pagination: { skip: 3, limit: 2, hasMore: false, nextSkip: 3 },
		});
	});

	it("returns an empty page when skip exceeds the available matches", async () => {
		await writeFile(join(vaultDir, "a.md"), "needle\n");

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				3,
				2,
				unauthorizedIdentity,
			),
		).resolves.toEqual({
			matches: [],
			pagination: { skip: 3, limit: 2, hasMore: false, nextSkip: 3 },
		});
	});

	it("returns an empty page when all matching files are restricted", async () => {
		await writeFile(
			join(vaultDir, "a.md"),
			"---\nrestricted: true\n---\nneedle\n",
		);

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				0,
				2,
				unauthorizedIdentity,
			),
		).resolves.toEqual({
			matches: [],
			pagination: { skip: 0, limit: 2, hasMore: false, nextSkip: 0 },
		});

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				0,
				2,
				authorizedIdentity,
			),
		).resolves.toEqual({
			matches: [
				{
					path: "a.md",
					line: 4,
					text: "needle\n",
				},
			],
			pagination: { skip: 0, limit: 2, hasMore: false, nextSkip: 1 },
		});
	});

	it("filters frontmatter and JSON restrictions before paginating mixed results", async () => {
		const restrictedByFrontmatter = join(
			vaultDir,
			"a-restricted-by-frontmatter.md",
		);
		const restrictedByJson = join(vaultDir, "b-restricted-by-json.md");
		const firstPublic = join(vaultDir, "c-public.md");
		const secondPublic = join(vaultDir, "d-public.md");

		await writeFile(
			restrictedByFrontmatter,
			"---\nrestricted: true\n---\nneedle private 1\nneedle private 2\n",
		);
		await writeFile(
			restrictedByJson,
			"needle JSON-private 1\nneedle JSON-private 2\n",
		);
		await writeFile(firstPublic, "needle public 1\nneedle public 2\n");
		await writeFile(secondPublic, "needle public 3\n");
		await writeFile(restrictedPaths, JSON.stringify([restrictedByJson]));

		const first = await service.searchNotes(
			"needle",
			false,
			true,
			0,
			2,
			unauthorizedIdentity,
		);
		const second = await service.searchNotes(
			"needle",
			false,
			true,
			first.pagination.nextSkip,
			2,
			unauthorizedIdentity,
		);

		expect(first).toEqual({
			matches: [
				{ path: "c-public.md", line: 1, text: "needle public 1\n" },
				{ path: "c-public.md", line: 2, text: "needle public 2\n" },
			],
			pagination: { skip: 0, limit: 2, hasMore: true, nextSkip: 2 },
		});
		expect(second).toEqual({
			matches: [
				{ path: "d-public.md", line: 1, text: "needle public 3\n" },
			],
			pagination: { skip: 2, limit: 2, hasMore: false, nextSkip: 3 },
		});

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				0,
				2,
				authorizedIdentity,
			),
		).resolves.toEqual({
			matches: [
				{
					path: "a-restricted-by-frontmatter.md",
					line: 4,
					text: "needle private 1\n",
				},
				{
					path: "a-restricted-by-frontmatter.md",
					line: 5,
					text: "needle private 2\n",
				},
			],
			pagination: { skip: 0, limit: 2, hasMore: true, nextSkip: 2 },
		});
	});

	it.each([
		{ query: "n..dle", regex: false, caseSensitive: true, lines: [3] },
		{ query: "n..dle", regex: true, caseSensitive: true, lines: [1, 3] },
		{ query: "needle", regex: false, caseSensitive: true, lines: [1] },
		{ query: "needle", regex: false, caseSensitive: false, lines: [1, 2] },
	])(
		"preserves query options: $query, regex=$regex, caseSensitive=$caseSensitive",
		async ({ query, regex, caseSensitive, lines }) => {
			await writeFile(join(vaultDir, "a.md"), "needle\nNEEDLE\nn..dle\n");
			const result = await service.searchNotes(
				query,
				regex,
				caseSensitive,
				0,
				10,
				unauthorizedIdentity,
			);
			expect(result.matches.map((match) => match.line)).toEqual(lines);
			expect(result.pagination).toEqual({
				skip: 0,
				limit: 10,
				hasMore: false,
				nextSkip: lines.length,
			});
		},
	);
});
