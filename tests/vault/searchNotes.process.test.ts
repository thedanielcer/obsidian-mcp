import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestrictionsService } from "../../src/auth/restrictions.service.ts";
import { VaultService } from "../../src/vault/vault.service.ts";
import {
	createRestrictedReaderEmails,
	unauthorizedIdentity,
} from "../fixtures/identities.ts";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: spawnMock,
}));

const { spawn: realSpawn } =
	await vi.importActual<typeof import("node:child_process")>(
		"node:child_process",
	);

describe("searchNotes process lifecycle", () => {
	let service: VaultService;
	let child: ChildProcessWithoutNullStreams | undefined;
	let childClosed: boolean;
	let filenameSearch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		spawnMock.mockReset();
		child = undefined;
		childClosed = false;
		const logger = pino({ level: "silent" });
		const restrictions = new RestrictionsService(
			logger,
			"",
			createRestrictedReaderEmails(),
			process.cwd(),
		);
		vi.spyOn(restrictions, "filterRestrictedNotes").mockImplementation(
			async (paths) => paths,
		);
		service = new VaultService(logger, process.cwd(), restrictions);
		// Isolate the streaming subprocess from the initial filename search.
		filenameSearch = vi.fn().mockResolvedValue({ stdout: "note.md\0" });
		Object.assign(service, {
			execFileAsync: filenameSearch,
			// These tests isolate subprocess lifecycle; filesystem validation is tested separately.
			filterNoteFiles: async (paths: string[]) => paths,
		});
	});

	afterEach(async () => {
		if (child && !childClosed) {
			const closed = new Promise<void>((resolve) => {
				child!.once("close", () => resolve());
			});
			child.kill();
			await closed;
		}
		vi.restoreAllMocks();
	});

	function runScript(script: string) {
		spawnMock.mockImplementation((_command, _args, options) => {
			child = realSpawn(process.execPath, ["-e", script], options);
			child.once("close", () => {
				childClosed = true;
			});
			return child;
		});
	}

	const match = JSON.stringify({
		type: "match",
		data: {
			path: { text: "note.md" },
			line_number: 1,
			lines: { text: "needle\n" },
		},
	});
	const writeMatch = `process.stdout.write(${JSON.stringify(match + "\n")});`;

	it("cancels after the lookahead match and waits for close without rejecting AbortError", async () => {
		runScript(`${writeMatch} ${writeMatch} setInterval(() => {}, 1000);`);

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				0,
				1,
				unauthorizedIdentity,
			),
		).resolves.toEqual({
			matches: [{ path: "note.md", line: 1, text: "needle\n" }],
			pagination: { skip: 0, limit: 1, hasMore: true, nextSkip: 1 },
		});
		expect(childClosed).toBe(true);
		expect(child!.killed).toBe(true);
	});

	it("terminates the child and preserves a JSON parse failure", async () => {
		runScript(
			'process.stdout.write("invalid JSON\\n"); setInterval(() => {}, 1000);',
		);

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				0,
				10,
				unauthorizedIdentity,
			),
		).rejects.toBeInstanceOf(SyntaxError);
		expect(childClosed).toBe(true);
		expect(child!.killed).toBe(true);
	});

	it("waits for natural close after stdout ends without cancelling", async () => {
		runScript(
			`${writeMatch} process.stdout.end(); setTimeout(() => {}, 50);`,
		);

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				0,
				10,
				unauthorizedIdentity,
			),
		).resolves.toMatchObject({
			matches: [{ path: "note.md", line: 1, text: "needle\n" }],
			pagination: { hasMore: false, nextSkip: 1 },
		});
		expect(childClosed).toBe(true);
		expect(child!.killed).toBe(false);
	});

	it("drains stderr and rejects a nonzero search failure", async () => {
		runScript(
			'process.stderr.write("x".repeat(200000) + "permission denied", () => process.exit(2));',
		);

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				0,
				10,
				unauthorizedIdentity,
			),
		).rejects.toThrow(/exit code 2.*permission denied/);
		expect(childClosed).toBe(true);
	});

	it("accepts exit code 1 when files no longer contain matches", async () => {
		runScript("process.exit(1);");

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				0,
				10,
				unauthorizedIdentity,
			),
		).resolves.toEqual({
			matches: [],
			pagination: { skip: 0, limit: 10, hasMore: false, nextSkip: 0 },
		});
		expect(childClosed).toBe(true);
	});

	it("propagates a spawn failure after close", async () => {
		spawnMock.mockImplementation((_command, _args, options) => {
			child = realSpawn(
				join(process.cwd(), "missing-ripgrep-executable"),
				[],
				options,
			);
			child.once("close", () => {
				childClosed = true;
			});
			return child;
		});

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				0,
				10,
				unauthorizedIdentity,
			),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(childClosed).toBe(true);
	});

	it("propagates a failure from the initial filename search", async () => {
		const error = Object.assign(new Error("ripgrep is unavailable"), {
			code: "ENOENT",
		});
		filenameSearch.mockRejectedValue(error);

		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				0,
				10,
				unauthorizedIdentity,
			),
		).rejects.toBe(error);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid skip %s before starting a search",
		async (skip) => {
			await expect(
				service.searchNotes(
					"needle",
					false,
					true,
					skip,
					10,
					unauthorizedIdentity,
				),
			).rejects.toBeInstanceOf(RangeError);
			expect(filenameSearch).not.toHaveBeenCalled();
			expect(spawnMock).not.toHaveBeenCalled();
		},
	);

	it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid limit %s before starting a search",
		async (limit) => {
			await expect(
				service.searchNotes(
					"needle",
					false,
					true,
					0,
					limit,
					unauthorizedIdentity,
				),
			).rejects.toBeInstanceOf(RangeError);
			expect(filenameSearch).not.toHaveBeenCalled();
			expect(spawnMock).not.toHaveBeenCalled();
		},
	);

	it("rejects a pagination window beyond safe integer precision", async () => {
		await expect(
			service.searchNotes(
				"needle",
				false,
				true,
				Number.MAX_SAFE_INTEGER,
				1,
				unauthorizedIdentity,
			),
		).rejects.toBeInstanceOf(RangeError);
		expect(filenameSearch).not.toHaveBeenCalled();
	});
});
