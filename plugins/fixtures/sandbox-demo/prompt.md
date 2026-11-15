# Acme Notes plugin instructions

When the user asks to remember, list or create a note, use the plugin tools:

- `plugin__com_acme_notes__save_note` with `{ "title": string, "body": string }`.
- `plugin__com_acme_notes__list_notes` to read saved notes.

These notes belong to the user's local plugin storage. Never claim a note was
saved unless the tool returned success. Keep note bodies concise and do not
store secrets or credentials.
