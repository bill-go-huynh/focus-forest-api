# focus-forest-api — Agent Instructions

The Focus Forest backend: **NestJS (TypeScript) + PostgreSQL**.

Workspace rules in `../AGENTS.md` also apply. These repo rules govern implementation details. They never override product behavior (`../focus_forest_product_features.md` plus the confirmed decisions listed in `../docs/README.md`). If a constraint here conflicts with product behavior, flag it. Shared docs live in `../docs/`.

## Read first

1. `../docs/00_PRODUCT_CONTEXT.md`
2. `../docs/06_DOMAIN_MODEL.md`
3. `../docs/07_API_BOUNDARIES.md`
4. `../docs/08_SYSTEM_ARCHITECTURE.md`
5. For growth, tree, or archive logic: `../docs/03_TREE_SYSTEM.md` §2–6, §11, §14
6. For goals, streaks, or rest days: `../docs/06_DOMAIN_MODEL.md` (rules) and `../docs/02_UX_PRINCIPLES.md` (how they should feel)

## Responsibilities

The server **owns product truth**:
- Session validation, focused-duration computation, and day/month attribution (by start time, in the tree's timezone context; `06_DOMAIN_MODEL.md` → Time and attribution)
- Monthly tree progression: growth, stage, fullness, blossoms, richness, traits, vitality
- Month archiving (lazy and idempotent until a scheduler is needed), archived snapshots, recaps
- Focus totals, daily and weekly goals, streaks, rest days, and streak recovery (rules in `06_DOMAIN_MODEL.md`)
- First-month proration of growth expectations, empty-month resting markers, and archiving that freezes earned state but not vitality
- Achievements, badges, ownership of species and cosmetics, collection data
- Follow graph (follow-first; mutual follows = friends), privacy enforcement, blocks, reports; Focus Together rooms and synchronized start; challenges
- Events, missions, Community Tree totals, fair leaderboards, seasonal content, notification scheduling
- **Product configuration**: all tunable values (see Product configuration in `06_DOMAIN_MODEL.md`), centrally defined, versioned, and never hardcoded
- Auth, users, and admin-scoped endpoints with roles and an audit log

## Not responsible for

- **Animation or visual layout.** Never add animation durations, spring parameters, pixel positions, colors, or transition types to responses. Describe *what* the tree is (stage, traits, vitality) and *what changed* (growth result). The client decides how it looks.

## Rules

- **Test first** (`../AGENTS.md` → Test-first development). Here that means Vitest unit tests next to the code (`*.spec.ts`), e2e tests in `test/` (`*.e2e-spec.ts`), and integration tests against the real PostgreSQL test database in `test/` (`*.int-spec.ts`). Every domain rule in `../docs/06_DOMAIN_MODEL.md` and `../docs/03_TREE_SYSTEM.md` that a phase implements gets unit tests before its code: validity and attribution, growth and stage monotonicity, vitality, goals, streaks with rest days and recovery, archiving and immutability. Tests pass configuration and the clock in explicitly, so changing a configuration value in a test changes the outcome without code changes. Endpoints, idempotency, concurrent archiving, and privacy enforcement get e2e or integration tests.
- **Domain correctness first.** Sessions are the source event. Derived state (streaks, tree progress, stats) must be recomputable from sessions and goals.
- **Monotonic progress.** Stage, fullness, blossoms, richness, and traits never decrease. Only vitality moves down. There is no "dead" tree state anywhere in the model.
- **Archived trees and recaps are immutable.** Growth-config changes are never retroactive.
- **Idempotency.** Session submission uses client-generated IDs, and month archiving is safe under concurrent requests.
- **Time is hard.** Handle timezones, month boundaries, and DST deliberately, with tests for them.
- **Clear module boundaries:** a modular monolith organized by domain, with modules added phase by phase (see `08_SYSTEM_ARCHITECTURE.md` §2). Don't reach into another module's internals.
- **Build the current phase only** (`../docs/12_PRODUCT_IMPLEMENTATION_PLAN.md`), but keep domain modules shaped so later phases fit.
- **Infrastructure arrives with the phase that needs it** (`../docs/08_SYSTEM_ARCHITECTURE.md` §6): WebSockets with Focus Together, jobs with notifications or aggregation, caching only if load requires it. No microservices, server-driven UI, or GraphQL.
- **Privacy:** session notes are personal data. Keep them out of logs.
- Additive, backward-compatible API changes, because mobile clients update slowly.

## Tooling

- NestJS 12 (ESM), TypeScript strict, Prisma 7 with the `pg` driver adapter, Vitest, ESLint, npm.
- Configuration: `@nestjs/config`, validated at boot in `src/config/env.validation.ts`. Document every variable in `.env.example`.
- Prisma: schema in `prisma/schema.prisma`, CLI config in `prisma7.config.ts`, generated client in `src/generated/prisma` (gitignored, regenerated on `npm install`). Use the `prisma:*` scripts.
- **Product configuration** (`src/product-config/`): domain code injects `ProductConfigService` and never reads the configuration tables (a lint rule enforces this).
  - `active()` returns one immutable version. Read every value of a computation from that one object and store its `version` with the result. `version(n)` reads an older version back.
  - Versions are immutable, and `active_product_config` points at the active one.
  - To add a key: define it with its type in `product-config.registry.ts`, add or update its row in `../docs/06_DOMAIN_MODEL.md` → Product configuration, and add a migration that inserts a new version containing every registry key and activates it. Unit tests use their own registry.
- **Auth** (`src/identity/`): email + password (scrypt from `node:crypto`), short-lived JWT access tokens (`jose`, HS256), and opaque refresh tokens stored as SHA-256 hashes that rotate on every use (replaying a used one revokes its family).
  - A global guard protects **every route by default**. Mark intentionally public routes with `@Public()`, and read the user with `@CurrentUser()`.
  - Never log request bodies, passwords, tokens, or `JWT_ACCESS_SECRET`.
- **Profile** (`src/identity/`, `GET`/`PATCH /me/profile`): the route has no user id, so users can only reach their own profile. Only display name, bio, and time zone are writable. The join date is `users.created_at`. `avatarUrl` stays null until avatar upload exists (`../docs/08_SYSTEM_ARCHITECTURE.md` §5). Time zones must be IANA names (`src/identity/time-zone.ts`) and are stored as given.
- **Preferences** (`src/identity/`, `GET`/`PATCH /me/preferences`): theme, sound, haptics, in-app reduced motion, and a setting (enabled, plus a local `HH:MM` time for the three reminders) for each of the ten spec §18 notification categories. Defaults are defined only in `preferences.defaults.ts`, and rows are created on the first change. Nothing sends notifications until Phase 18.
- **Time:** inject `Clock` (`src/common/clock.ts`) instead of calling `new Date()` in logic. Tests use `FixedClock`.
- Dependency rules: `../AGENTS.md` → Dependencies and supply-chain security.
- Local PostgreSQL runs in Docker (`compose.yaml`, `npm run db:up`), with `focus_forest` for development and `focus_forest_test` for integration tests.
- Integration tests (`npm run test:int`) start from an empty test database with all migrations applied, and every test starts with empty tables. The helpers in `test/database/` refuse any database whose name doesn't end with `_test`.
- `npm run check` runs typecheck, lint, format check, unit, e2e, and integration tests. It needs `npm run db:up` first.

## Current state

Bootstrapped: root module, env validation, helmet, global validation pipe, Swagger at `/docs` outside production, a lazily connecting `PrismaService`, a liveness endpoint `GET /health`, the database and integration-test foundation (Phase 1 module A1), the Product configuration mechanism (A2), auth (A3: sign up, sign in, refresh, global guard), the user profile with time zone (A4), and preferences with the notification-preference structure (A5). Phase 1 API modules A1–A5 are done. Configuration version 1 is active and holds no keys yet. Models: the configuration tables, `User` (email, password hash, status, display name, bio, avatar URL, time zone), `RefreshToken`, `UserPreferences`, and `NotificationPreference`. No domain modules exist yet. The next step is Phase 1 in `../docs/12_PRODUCT_IMPLEMENTATION_PLAN.md`. Until admin content tools exist (Phase 19), content definitions live here as versioned seed data. Until admin content tools exist (Phase 19), content definitions live here as versioned seed data.
