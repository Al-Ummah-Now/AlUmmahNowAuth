# Theme packages (format v1), Auth's copy

Auth's themes use the platform theme package format, version 1:
[docs/themes/README.md](https://github.com/Al-Ummah-Now/AlUmmahNow/blob/main/docs/themes/README.md)
in the AlUmmahNow monorepo.

This folder is a copy of that format's library (`packages/theme-packages/src` at
`66cc5017f48b72d100671bcea401e34d33139321`) and its schema (`theme-package.v1.schema.json`, from
`docs/themes`). Auth has no runtime or build dependency on the monorepo; the files are copied.
Don't edit them here: copy a newer version over them and run `pnpm themes:check`, which fails when
`schema.generated.ts` and the JSON schema disagree.

Auth's own additions (the `x-auth` extension, the compiler for the sign-in pages, storage) live in
`../auth-theme`.
