import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

/** Compare native filesystem paths with a separator-aware boundary check. */
export function isWithinVault(root: string, path: string): boolean {
	const child = relative(root, path);
	return (
		child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
	);
}

export function assertWithinVault(root: string, path: string): void {
	if (!isWithinVault(root, path)) {
		throw new Error("Note path must be inside the vault");
	}
}

/** Tool paths are vault-relative; accept either platform's separators. */
export function resolveNotePath(root: string, input: string): string {
	if (
		!input ||
		input.includes("\0") ||
		isAbsolute(input) ||
		win32.isAbsolute(input) ||
		/^[a-z]:/i.test(input)
	) {
		throw new Error("Note path must be relative to the vault");
	}
	const path = resolve(root, input.replace(/\\/g, "/"));
	assertWithinVault(root, path);
	return path;
}

/** Public paths always use forward slashes, including on Windows. */
export function toNotePath(root: string, path: string): string {
	const absolute = resolve(path);
	assertWithinVault(root, absolute);
	return relative(root, absolute).split(sep).join("/");
}
