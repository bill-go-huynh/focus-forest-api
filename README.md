# focus-forest-api

The Focus Forest backend: NestJS (TypeScript), PostgreSQL, Prisma ORM.

Product and domain docs live in the workspace (`../docs/`). Agent and implementation rules: `AGENTS.md`.

## Setup

Requires Node.js 24, npm 11, and Docker (for the local PostgreSQL). Any deployed database must be PostgreSQL 17 or later with UTF8 encoding.

```sh
cp .env.example .env           # then fill JWT_ACCESS_SECRET and ADMIN_JWT_SECRET (below)
npm install                    # also generates the Prisma client
npm run db:up                  # PostgreSQL 18 with focus_forest and focus_forest_test
npm run prisma:migrate:deploy  # apply migrations to the development database
npm run build
DATABASE_URL="postgresql://focus_forest:focus_forest@localhost:5432/focus_forest?schema=public" npm run content:seed
npm run start:dev              # http://localhost:3000, Swagger at /docs
```

- Secrets: generate each with `node -e "console.log(crypto.randomBytes(48).toString('base64url'))"`. `JWT_ACCESS_SECRET` and `ADMIN_JWT_SECRET` must differ.
- In development the API creates the admin `admin@focusforest.test` / `admin123` on start. Elsewhere, create one with `ADMIN_PASSWORD='…12+ chars…' npm run admin:create -- --email <email> --role admin` (after `npm run build`).
- Optional in `.env`: `GOOGLE_CLIENT_IDS` (Google sign-in), `SMTP_URL` (password-reset mail; without it the code is written to the log), `PUSH_PROVIDER=expo` (real push), `DEMO_TOOLS=on` (the admin Demo tab).
- Docker must be running for `db:up` and `npm run check` (the integration tests use `focus_forest_test`).

`compose.yaml` creates both databases the first time its volume is created. To start over, run `docker compose down -v` and then `npm run db:up`.

Hosting (Supabase, DigitalOcean App Platform) is described in `DEPLOY.md` and the workspace `DEPLOY_AFTER_DEMO.md`.

- `GET /health` reports that the process is up.
- `POST /auth/sign-up`, `/auth/sign-in`, and `/auth/refresh` return an access token and a refresh token. Every other route requires `Authorization: Bearer <access token>`.
- `GET /me/profile` and `PATCH /me/profile` read and update the signed-in user's profile (display name, bio, time zone).
- `GET /me/export` downloads a JSON copy of everything stored about the signed-in user; `DELETE /me { password }` deletes the account and its data at once.
- `GET /me/preferences` and `PATCH /me/preferences` read and update theme, sound, reduced motion, and per-category notification settings (with the three reminders' local times).
- Push notifications (Phase 6): the app registers its Expo push token (`PUT/DELETE /me/devices/:token`) and holds a focus lease while focusing (`PUT/DELETE /me/focus/active`). A Postgres job queue and a background worker plan and send them. Delivery is off until `PUSH_PROVIDER=expo` (and `EXPO_ACCESS_TOKEN`, optional) is set; `JOBS_POLL_SECONDS` sets the worker's pace (0 turns it off).
- Staff use `/admin/*` (see `AGENTS.md`): support and moderation, the content catalog, live operations, and configuration versions.
- Set `JWT_ACCESS_SECRET` in `.env` (see `.env.example` for how to generate one).
- Swagger UI is served at `/docs` when `NODE_ENV` is not `production`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run start:dev` | Start with watch mode |
| `npm run build` / `start:prod` | Compile to `dist/` and run it |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint (typescript-eslint, type-aware) |
| `npm run format` / `format:check` | Prettier |
| `npm test` / `test:e2e` / `test:cov` | Vitest unit, e2e, and coverage |
| `npm run test:int` | Integration tests against the PostgreSQL test database (needs `db:up`) |
| `npm run check` | Typecheck, lint, format check, unit, e2e, and integration tests |
| `npm run db:up` / `db:down` | Start or stop the local PostgreSQL container |
| `npm run prisma:generate` | Generate the Prisma client into `src/generated/prisma` |
| `npm run prisma:validate` / `prisma:format` | Validate or format `prisma/schema.prisma` |
| `npm run prisma:migrate:dev` | Create and apply a migration in development |
| `npm run prisma:migrate:deploy` / `prisma:migrate:status` | Apply pending migrations / show migration status |
| `npm run prisma:studio` | Open Prisma Studio |
