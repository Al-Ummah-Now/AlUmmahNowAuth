# Theme packages (format v1), Auth's copy

Auth's themes use the platform theme package format, version 1:
[docs/themes/README.md](https://github.com/Al-Ummah-Now/AlUmmahNow/blob/main/docs/themes/README.md)
in the AlUmmahNow monorepo.

This folder is a copy of that format's library (`packages/theme-packages/src` at
`2a4c3d6e114715f434a79465cb5742b0c14d0df5`: components' light-only `lightStyle` and the lantern
`street` section) and its schema (`theme-package.v1.schema.json`, from `docs/themes`).
`builtins.generated.ts` lists the monorepo's built-ins; Auth's own are in `../auth-theme/themes`. Auth has no runtime or build dependency on the monorepo; the files are copied.
Don't edit them here: copy a newer version over them and run `pnpm themes:check`, which fails when
`schema.generated.ts` and the JSON schema disagree.

Auth's own additions (the `x-auth` extension, the compiler for the sign-in pages, storage) live in
`../auth-theme`.
