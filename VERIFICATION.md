# Verification scope / 验证范围

Source version **1.9.3**, public documentation updated **2026-10-10**.

| Check | Evidence and scope |
| --- | --- |
| Node logic suite | `node --test tests/*.test.mjs`: 303/303 passed on macOS for this source snapshot |
| TOC interaction acceptance (2026-10-09) | Isolated Chrome checks 13/13; hover open/close, page selection, alignment, keyboard, 390px touch and reduced motion; no page errors |
| macOS application acceptance (2026-10-09) | 4/4 real Electron-window checks; source/bundle/live resources aligned for the installed 1.9.3 build |
| Public screenshots (2026-10-10) | Fresh isolated browser/library, built-in original sample book; reading, music panel and TOC captured; no page errors |
| Public HTML browser checks | 12 desktop / 390px page loads with JavaScript disabled; titles, visible images and no horizontal overflow |
| Public information site | `python3 scripts/check_public_site.py`: local links/assets, structured-data parsing, canonical URLs, version and bilingual FAQ consistency |
| Public source hygiene | Personal SQLite, media library, local backups, internal audits, agent ledgers and installed/build output excluded from Git |

The public screenshots show demonstrative material, not personal reading history. Logic checks include both behavior tests and source-wiring checks; their count is not a claim that every user flow has been tested on all devices.

## Platform and feature boundaries

- Actual browser and desktop acceptance occurred on macOS. Windows / Linux launchers have not had separate on-device acceptance.
- PDF import extracts a text layer and reflows it. Scans require external OCR; original page images/layout are not preserved.
- NetEase / QQ official embed loading does not prove every track plays; platform and track restrictions remain.
- A generated source ZIP is not a signed or notarized macOS installer.
- Earlier machine-pressure measurements are not offered as application performance benchmarks. No speed or frame-rate guarantee is made.
- Source publication and a project-information website do not create automatic cloud sync or an online hosted book account.
- The full rain shader has CC BY-NC-SA terms; see [license scope](LICENSE-NOTES.md).

Current implementation entry points are linked from [FEATURES.md](docs/FEATURES.md); public facts and limitations are in [FAQ.md](docs/FAQ.md). Personal/raw acceptance artifacts remain local and are not included in the repository.
