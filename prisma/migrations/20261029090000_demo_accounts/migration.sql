-- DM.1 Demo tools: the accounts a demo world made, so a world's emails can be any address.
-- CreateTable
CREATE TABLE "demo_accounts" (
    "user_id" UUID NOT NULL,
    "world" INTEGER NOT NULL,
    "persona" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_accounts_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "demo_accounts_world_persona_key" ON "demo_accounts"("world", "persona");

-- AddForeignKey
ALTER TABLE "demo_accounts" ADD CONSTRAINT "demo_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Worlds made before this table, recognised by their generated addresses.
INSERT INTO "demo_accounts" ("user_id", "world", "persona")
SELECT "id",
       (regexp_match("email", '^demo(\d+)'))[1]::INTEGER,
       COALESCE((regexp_match("email", '^demo\d+-([a-z-]+)@'))[1], 'main')
FROM "users"
WHERE "email" ~ '^demo\d+(-(comeback|recovery|friend-mai|friend-khoa|friend-linh))?@focusforest\.test$';
