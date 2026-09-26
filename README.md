# focus-forest-api

The Focus Forest backend: NestJS (TypeScript), PostgreSQL, Prisma ORM.

Product and domain docs live in the workspace (`../docs/`). Agent and implementation rules: `AGENTS.md`.

## Setup

Requires Node.js 24, npm 11, and Docker (for the local PostgreSQL).

```sh
cp .env.example .env
npm install                    # also generates the Prisma client
npm run db:up                  # PostgreSQL 18 with focus_forest and focus_forest_test
npm run prisma:migrate:deploy  # apply migrations to the development database
npm run start:dev
```

`compose.yaml` creates both databases the first time its volume is created. To start over, run `docker compose down -v` and then `npm run db:up`.

- `GET /health` reports that the process is up.
- `POST /auth/sign-up`, `/auth/sign-in`, and `/auth/refresh` return an access token and a refresh token. Every other route requires `Authorization: Bearer <access token>`.
- `GET /me/profile` and `PATCH /me/profile` read and update the signed-in user's profile (display name, bio, time zone).
- `GET /me/preferences` and `PATCH /me/preferences` read and update theme, sound, haptics, reduced motion, and per-category notification settings. They are stored only; nothing is sent yet.
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
