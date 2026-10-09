# Contributing to Immersive Reader

The frontend uses native ES modules and CSS. Local Node/Python servers and all runtime reading-engine files are included. Browser use requires no npm install.

1. Fork and clone the repository; run `sh start.sh` or the Python launcher described in the README.
2. Use a separate test port (`python3 scripts/serve.py --port 19210 --no-open`), which creates an isolated library under `.preview/`, for changes that import/delete/reset data.
3. Run `node --test tests/*.test.mjs`. Use actual browser checks when changing reading or storage flows.
4. For project-site edits, update `docs/project-facts.json`, run `python3 scripts/build_public_site.py`, then `python3 scripts/check_public_site.py`.
5. Open a pull request with the behavior changed, reproduction steps and verification scope. Preserve third-party notices; review [LICENSE-NOTES.md](LICENSE-NOTES.md).

Report issues in [GitHub Issues](https://github.com/SJT-bright/immersive-reader/issues). Include the source version, browser/OS, file format and a minimal reproduction. Use synthetic or redistributable sample material in public reports.

中文：功能文案以当前源码和验证范围为准。更新功能或版本时，同时更新事实清单、README、常见问题与版本说明，避免不同入口描述冲突。
