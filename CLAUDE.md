# CLAUDE.md

Guidance for Claude Code in AlUmmahNowAuth (sign-in, Profile, Auth admin). Start with `README.md`, `ARCHITECTURE.md` and `CONTRIBUTING.md`.

## UI copy

- **Tone (en + ar)**: Al Ummah Now is a content-sharing site, not a lectures library. Use YouTube's neutral words: videos, Shorts, live streams, posts, playlists, channels, creators, the community; verbs watch, upload, share, subscribe, save, explore. Never describe the platform as lessons, lectures, courses, a library or "beneficial knowledge" («دروس، محاضرات، مكتبة، العلم النافع»), and no entertainment or hype words. Full guide: wiki page "Copy Tone Guide".
- **Arabic word for "video"**: «مرئي / مرئيات»; «المقاطع القصيرة» stays for Shorts. See the wiki page "Arabic glossary".
- Sign-in and Profile are English unless `?lang=ar`; every string exists in both languages.
- **Numbers in Arabic**: Arabic pages and emails show Eastern Arabic (Hindi) numerals ٠–٩ for every formatted value (counts, dates, times, durations, money); English shows Arabic numerals 0–9. Format through `packages/ui/src/format.ts` only (`ar-u-nu-arab`: plain `ar` gives 0–9 in Node but ٠–٩ in WebKit, which breaks hydration). No digits typed into copy: use a placeholder or `formatNumber`. Codes the user types (sign-in codes), ids, URLs and inputs stay as they are; code inputs accept ٠–٩ (`toAsciiDigits`). Guards: `apps/profile/src/digits.test.ts` (no direct `Intl`/`toLocale*String`, no `ar-SA`/`ar-EG`/`nu-latn`) and `pnpm test:hydration` (WebKit, Arabic).
