# Vault paths

Tool inputs and outputs use paths relative to `VAULT_DIR`, such as
`Projects/My note.md`. Responses always use `/` separators on Windows and Linux.
Pass a returned path directly to another note tool.

Inputs accept `/`, `\`, and mixed separators and normalize `.` and `..` segments.
Paths escaping the vault, absolute paths, Windows drive paths, UNC paths, empty
paths, and NUL bytes are rejected. A backslash is treated as a separator, not a
literal filename character. Existing symlinks are resolved before checking the
vault boundary. `VAULT_DIR` itself may be relative or a directory symlink.
