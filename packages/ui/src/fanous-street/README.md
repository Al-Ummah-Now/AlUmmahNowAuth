# Fanous lantern street (vendored)

The shared street module of every Al Ummah Now app (AlUmmahNow `packages/fanous-tokens/street`;
design record: AlUmmahNow `docs/design/FAWANEES-STREET.md`), copied here at the commit in
`fanous-street.lock.json` by `pnpm street:sync -- --ref <sha>`. Never edit the copies:
`pnpm themes:check` fails when a file differs from the lock.

How Auth uses it:

- The street is pre-made art: a wide WebP tile of strings and lit lanterns, repeated behind the
  page by `fanous-street.css`, over the distant lights. The theme compiler
  (`../auth-theme/compile.ts`) emits the `--fanous-street-*` tokens per `prefers-color-scheme`
  (`--fanous-street-on: 0` for themes without a street): the lights, the 4 tile variants
  (`--fanous-street-tile-1..4`), `--fanous-street-faint` and `--fanous-street-lights-opacity`.
- The built-in tiles are too large to bundle into the workers, so `scripts/themes/build.ts` writes
  them to `apps/auth/public/fanous/street/` and the auth Worker serves them as static files
  (`assets` in `apps/auth/wrangler*.json`); the profile page and the accounts admin load them from
  the auth origin. `ThemeStore` reads them through `env.ASSETS` (theme export, `/themes/assets/<hash>`).
- The tile variant is picked on the server for every response and sent as
  `<html data-fanous-street-variant="N">` (`streetVariantAttr` / `pickStreetVariant`): the
  sign-in pages (`decorateHtml`, `streetVariant`), the profile page (`renderHomePage`, `cookie`)
  and the accounts admin (`root.tsx` loader). Only that tile downloads. A valid
  `aun_street_variant=1..4` cookie pins it (visual tests); there is no inline picker script.
- Each app serves `street.<hash>.css` and `start.<hash>.js` (the module, then `startStreet()`)
  from its own origin under `/fanous-street/` (`index.ts`), and links them after the theme CSS
  when the theme switches the street on: sign-in pages (`decorateHtml`, `street: true`), the
  profile page (`renderHomePage`, `street: true`), the accounts admin (`root.tsx`). The admin
  preview loads nothing (it runs no scripts).
- The body keeps a flat page colour; wrappers that paint it become transparent under `html.fanous-street`: the sign-in root
  (`[data-component="root"]`, in the compiled theme) and the admin page (`[data-shell="page"]`).
  The admin follows its light/dark mode, and its page titles sit on the street, so it shows the
  street at the theme's faint opacity (`--fanous-street-opacity: var(--fanous-street-faint)`).
