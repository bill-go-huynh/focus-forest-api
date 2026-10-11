# Deploying the Focus Forest API

This guide prepares the API for the Core Loop Checkpoint (CR.7). It works on any host that can run a container next to a managed PostgreSQL. The host is not chosen yet (docs/08 → open decisions).

## What you need

- PostgreSQL 16 or newer. Production uses its own database and credentials. The test and development databases are never used.
- A container runtime, with the image built from `Dockerfile`.
- The secrets below, stored in the host's secret store. They never go in the repository.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` (set in the image) |
| `DATABASE_URL` | yes | Production PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | yes | At least 32 random characters |
| `ADMIN_JWT_SECRET` | for the admin | At least 32 random characters, different from `JWT_ACCESS_SECRET`. Without it, admin routes answer 503 |
| `CORS_ORIGINS` | for the admin | The admin web app's origin, e.g. `https://admin.example.com` |
| `PORT` | no | Default 3000 |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`, `ADMIN_TOKEN_TTL_SECONDS` | no | Defaults 900, 30, and 1800 |
| `PUSH_PROVIDER` | for push | `expo` delivers push notifications through Expo. The default `none` delivers nothing and records each attempt as failed (`PushDisabled`) |
| `EXPO_ACCESS_TOKEN` | no | Set when the Expo project requires signed push requests |
| `JOBS_POLL_SECONDS` | no | How often the API runs due background jobs and notifications. Default 15; `0` turns the worker off |

Generate a secret with:

```sh
node -e "console.log(crypto.randomBytes(48).toString('base64url'))"
```

## Build

```sh
docker build -t focus-forest-api .                          # the API (runtime stage)
docker build --target migrate -t focus-forest-api-migrate . # the migration job
```

## Release, every time

1. **Back up the database** (see Backups below).
2. **Run the migration job once**, before the new API starts:

   ```sh
   docker run --rm -e DATABASE_URL=… focus-forest-api-migrate
   ```

   Migrations are additive and never edited once committed. `prisma migrate deploy` applies only the new ones.
3. **Start or replace the API container** with the environment above.
4. **Check its health:** `GET /health` answers 200. The image has a container health check on it.
5. **The product configuration** is seed data. The migrations insert each version and make the latest one active, so nothing more is needed. Confirm with `GET /admin/config` once an admin exists.

## First admin

There is no admin-creation endpoint. Run the CLI once from the build image, against the production database:

```sh
docker run --rm -e DATABASE_URL=… -e ADMIN_PASSWORD='…' focus-forest-api-migrate \
  npm run admin:create -- --email you@example.com --role admin
```

The password needs 12 or more characters. Pass it only through the environment, never as an argument. Create `support` admins the same way.

## Content

Events, Community Trees, and seasonal themes are dated content, so no migration inserts them. Apply the launch content once, and again after a release that adds to it:

```sh
docker run --rm -e DATABASE_URL=… focus-forest-api-migrate npm run content:seed
```

It only adds what is missing and says what it added and kept. Content already in the database is never changed, so edits made since stay as they are. A pack with problems is refused before anything is written.

## Backups

- Take daily automatic backups with point-in-time recovery if the host offers it.
- Take a manual backup before every migration.
- Test a restore into a scratch database once before the checkpoint starts.

## Not here yet (deferred by decision)

- **Crash and error monitoring** (docs/08 §6): deferred while only the owner's device uses the build. Add it before anyone outside the team does.
- **Rate limiting** of sign-in and admin sign-in.
- **The admin web app's own hosting.** It is a Next.js app (`focus-forest-admin`, `npm run build && npm start`). Point it at the API with `NEXT_PUBLIC_API_URL`, and list its origin in `CORS_ORIGINS`.
