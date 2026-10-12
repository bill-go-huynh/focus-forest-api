-- A6.4 The content admin role (docs/09: content definitions and live content). Content staff
-- reach only the routes that name them; every other admin route keeps the early roles.
ALTER TYPE "admin_role" ADD VALUE 'content';
