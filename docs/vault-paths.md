# Vault paths

Tool inputs and outputs use paths relative to `VAULT_DIR`, such as
`Projects/My note.md`. Responses always use `/` separators on Windows and Linux.
Pass a returned path directly to another note tool.

Inputs accept `/`, `\`, and mixed separators and normalize `.` and `..` segments.
Paths escaping the vault, absolute paths, Windows drive paths, UNC paths, empty
paths, and NUL bytes are rejected. A backslash is treated as a separator, not a
literal filename character. Existing symlinks are resolved before checking the
vault boundary. `VAULT_DIR` itself may be relative or a directory symlink.

## JSON restrictions

`RESTRICTED_NOTES_JSON` points to a JSON array of note or directory paths:

```json
["Private", "Projects/secret.md"]
```

Relative entries are resolved against the vault root. Existing absolute server
paths are also accepted. Directory entries cover every descendant, but `Private`
does not cover `Private-Archive`. Both slash styles are accepted for relative
entries. Absolute paths must belong to the server's filesystem, not another
machine's drive. Entries outside the vault are rejected.

Restrictions apply before pagination to listings, filename lookup and content
search, and before direct reads, outlines and existing-note edits. Symlink aliases
cannot bypass a restricted target. Missing entries remain valid for future notes.
Emails in `CAN_READ_RESTRICTED_NOTES` retain access to restricted notes.
