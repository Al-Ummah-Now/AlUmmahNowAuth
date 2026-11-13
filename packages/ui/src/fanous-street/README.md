# Fanous lantern street (vendored)

The shared street module of every Al Ummah Now app (AlUmmahNow `packages/fanous-tokens/street`;
design record: AlUmmahNow `docs/design/FAWANEES-STREET.md`), copied here at the commit in
`fanous-street.lock.json` by `pnpm street:sync -- --ref <sha>`. Never edit the copies:
`pnpm themes:check` fails when a file differs from the lock.

How Auth uses it:

- The theme compiler (`../auth-theme/compile.ts`) emits the `--fanous-street-*` tokens per
  `prefers-color-scheme` (`--fanous-street-on: 0` for themes without a street).
- Each app serves `street.<hash>.css` and `start.<hash>.js` (the module, then `startStreet()`)
  from its own origin under `/fanous-street/` (`index.ts`), and links them after the theme CSS
  when the theme switches the street on: sign-in pages (`decorateHtml`, `street: true`), the
  profile page (`renderHomePage`, `street: true`), the accounts admin (`root.tsx`). The admin
  preview loads nothing (it runs no scripts).
- Page colour wrappers become transparent under `html.fanous-street`: the sign-in root
  (`[data-component="root"]`, in the compiled theme) and the admin page (`[data-shell="page"]`).
  The admin is dark whatever the device's setting, so it takes the theme's dark-scheme street.
