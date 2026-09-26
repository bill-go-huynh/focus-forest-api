# focus-forest-api — Claude Instructions

Claude: read and follow **`./AGENTS.md`** (this repo's rules) and **`../AGENTS.md`** (workspace rules) before making changes. This file only points you there.

- Product source of truth: `../focus_forest_product_features.md`
- Docs and reading guide: `../docs/README.md`
- For backend work, read the domain model, API boundaries, and system architecture docs first (`../docs/06`–`08`).

Key reminders: the server owns product truth (sessions, growth, streaks, rewards) and never dictates animation or layout. Progress is monotonic, and the tree never dies. Archived trees are immutable. Tunable values live in versioned configuration. Keep a simple modular monolith, and add infrastructure only in the phase that needs it.

Test first: write tests for the documented behavior, see them fail, then implement until `npm run check` passes.

If a request conflicts with the product or domain docs, flag it. Don't silently diverge. Don't commit unless asked.
