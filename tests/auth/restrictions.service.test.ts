import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";
import pino from "pino";
import pretty from "pino-pretty";
import {
	authorizedIdentity,
	createRestrictedReaderEmails,
	unauthorizedIdentity,
} from "../fixtures/identities.ts";

describe("RestrictionsService", () => {
	let testDir: string;
	let restrictedNotesPath: string;
	let service: RestrictionsService;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "obsidian-restrictions-"));
		restrictedNotesPath = join(testDir, "restricted-notes.json");
		await writeFile(restrictedNotesPath, "[]");
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
		service = new RestrictionsService(
			logger,
			restrictedNotesPath,
			createRestrictedReaderEmails(),
			testDir,
		);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	async function createNote(contents: string): Promise<string> {
		const notePath = join(testDir, "note.md");
		await writeFile(notePath, contents);
		return notePath;
	}

	describe("isRestricted", () => {
		it.each([
			["a YAML boolean", "restricted: true"],
			["a double-quoted property name", '"restricted": true'],
			["a single-quoted property name", "'restricted': true"],
			["a double-quoted string", 'restricted: "true"'],
			["a single-quoted string", "restricted: 'true'"],
			["uppercase text", "RESTRICTED: TRUE"],
			["surrounding whitespace", "  restricted  :  true  "],
			["an inline comment", "restricted: true # private note"],
		])(
			"restricts a note when the property is %s",
			async (_description, property) => {
				const notePath = await createNote(
					["---", "title: Secret", property, "---", "# Note"].join(
						"\n",
					),
				);

				await expect(service.isRestricted(notePath)).resolves.toBe(
					true,
				);
			},
		);

		it.each([
			["a YAML false boolean", "restricted: false"],
			['the string "false"', 'restricted: "false"'],
			["a number", "restricted: 1"],
			["yes", "restricted: yes"],
			["an empty value", "restricted:"],
			["a similar property name", "unrestricted: true"],
			["a mismatched quoted property name", '"restricted: true'],
			["extra text after true", "restricted: true-ish"],
			["true inside an array", "restricted: [true]"],
		])(
			"does not restrict a note when the property is %s",
			async (_description, property) => {
				const notePath = await createNote(
					["---", property, "---", "# Note"].join("\n"),
				);

				await expect(service.isRestricted(notePath)).resolves.toBe(
					false,
				);
			},
		);

		it.each([
			["an empty note", ""],
			["plain Markdown", "# Public note\n\nNothing to see here."],
			["an empty properties block", "---\n---\n# Public note"],
			[
				"properties without restricted",
				"---\ntitle: Public\ntags: [one, two]\n---",
			],
		])("does not restrict %s", async (_description, contents) => {
			const notePath = await createNote(contents);

			await expect(service.isRestricted(notePath)).resolves.toBe(false);
		});

		it("ignores a restricted-looking property in the note body", async () => {
			const notePath = await createNote(
				[
					"---",
					"title: Public",
					"---",
					"# Note",
					"restricted: true",
				].join("\n"),
			);

			await expect(service.isRestricted(notePath)).resolves.toBe(false);
		});

		it("supports Windows-style line endings", async () => {
			const notePath = await createNote(
				["---", "restricted: true", "---", "# Note"].join("\r\n"),
			);

			await expect(service.isRestricted(notePath)).resolves.toBe(true);
		});

		it.each(["\n", "\r\n"])(
			"supports a UTF-8 BOM before frontmatter with %j line endings",
			async (lineEnding) => {
				const notePath = await createNote(
					`\uFEFF${["---", '"restricted": true', "---"].join(lineEnding)}`,
				);
				await expect(service.isRestricted(notePath)).resolves.toBe(
					true,
				);
			},
		);

		it("finds the property when frontmatter spans multiple stream chunks", async () => {
			const padding = `description: ${"x".repeat(6 * 1024)}`;
			const notePath = await createNote(
				["---", padding, "restricted: true", "---", "# Note"].join(
					"\n",
				),
			);

			await expect(service.isRestricted(notePath)).resolves.toBe(true);
		});

		it("rejects when the note does not exist", async () => {
			const missingPath = join(testDir, "missing.md");

			await expect(
				service.isRestricted(missingPath),
			).rejects.toMatchObject({
				code: "ENOENT",
			});
		});
	});

	describe("filterRestrictedNotes", () => {
		async function createNamedNote(
			name: string,
			contents: string,
		): Promise<string> {
			const notePath = join(testDir, name);
			await writeFile(notePath, contents);
			return notePath;
		}

		async function setRestrictedPaths(paths: string[]): Promise<void> {
			await writeFile(restrictedNotesPath, JSON.stringify(paths));
		}

		it("filters notes restricted by either the JSON file or note properties", async () => {
			const publicWithoutProperties = await createNamedNote(
				"public-without-properties.md",
				"# Public note",
			);
			const publicWithProperties = await createNamedNote(
				"public-with-properties.md",
				[
					"---",
					"title: Public",
					"restricted: false",
					"---",
					"# Public",
				].join("\n"),
			);
			const restrictedByJsonOne = await createNamedNote(
				"restricted-by-json-one.md",
				"# No restricted property",
			);
			const restrictedByJsonTwo = await createNamedNote(
				"restricted-by-json-two.md",
				"---\ntitle: Also restricted by JSON\n---",
			);
			const restrictedByBooleanProperty = await createNamedNote(
				"restricted-by-boolean-property.md",
				"---\nrestricted: true\n---\n# Private",
			);
			const restrictedByStringProperty = await createNamedNote(
				"restricted-by-string-property.md",
				'---\nrestricted: "true"\n---\n# Also private',
			);

			await setRestrictedPaths([
				restrictedByJsonOne,
				restrictedByJsonTwo,
			]);

			const notes = [
				restrictedByJsonOne,
				publicWithoutProperties,
				restrictedByBooleanProperty,
				restrictedByJsonTwo,
				publicWithProperties,
				restrictedByStringProperty,
			];

			await expect(
				service.filterRestrictedNotes([...notes], unauthorizedIdentity),
			).resolves.toEqual([publicWithoutProperties, publicWithProperties]);
			await expect(
				service.filterRestrictedNotes([...notes], authorizedIdentity),
			).resolves.toEqual(notes);
		});

		it("filters a note restricted by both sources without affecting other notes", async () => {
			const restrictedByBoth = await createNamedNote(
				"restricted-by-both.md",
				"---\nrestricted: true\n---\n# Private",
			);
			const publicNote = await createNamedNote(
				"still-public.md",
				"# Public",
			);
			await setRestrictedPaths([restrictedByBoth]);

			await expect(
				service.filterRestrictedNotes(
					[restrictedByBoth, publicNote],
					unauthorizedIdentity,
				),
			).resolves.toEqual([publicNote]);
			await expect(
				service.filterRestrictedNotes(
					[restrictedByBoth, publicNote],
					authorizedIdentity,
				),
			).resolves.toEqual([restrictedByBoth, publicNote]);
		});

		it("returns every note in its original order when none are restricted", async () => {
			const firstNote = await createNamedNote("first.md", "# First");
			const secondNote = await createNamedNote(
				"second.md",
				"---\nrestricted: false\n---\n# Second",
			);

			await expect(
				service.filterRestrictedNotes(
					[firstNote, secondNote],
					unauthorizedIdentity,
				),
			).resolves.toEqual([firstNote, secondNote]);
		});

		it("returns an empty list when given no notes", async () => {
			await expect(
				service.filterRestrictedNotes([], unauthorizedIdentity),
			).resolves.toEqual([]);
		});

		it("rejects a restricted-paths file that is not an array of strings", async () => {
			await writeFile(
				restrictedNotesPath,
				JSON.stringify(["valid.md", 42, true]),
			);

			await expect(
				service.filterRestrictedNotes([], unauthorizedIdentity),
			).rejects.toThrow();
		});
	});
});
