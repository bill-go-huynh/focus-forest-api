-- CreateTable
CREATE TABLE "product_config_versions" (
    "version" SERIAL NOT NULL,
    "values" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_config_versions_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "active_product_config" (
    "id" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL,
    "activated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_product_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "active_product_config_version_key" ON "active_product_config"("version");

-- AddForeignKey
ALTER TABLE "active_product_config" ADD CONSTRAINT "active_product_config_version_fkey" FOREIGN KEY ("version") REFERENCES "product_config_versions"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only one row can exist: the pointer to the active version.
ALTER TABLE "active_product_config" ADD CONSTRAINT "active_product_config_singleton" CHECK ("id");

-- Seed version 1 and make it active. It holds no values: each key is added,
-- with its value, by the phase that introduces it (docs/06_DOMAIN_MODEL.md →
-- Product configuration). Session and growth values are chosen in Phases 2–3.
INSERT INTO "product_config_versions" ("values", "note")
VALUES ('{}'::jsonb, 'Initial version. No keys yet; each phase adds the keys it introduces.');

INSERT INTO "active_product_config" ("id", "version", "activated_at")
VALUES (true, 1, CURRENT_TIMESTAMP);
