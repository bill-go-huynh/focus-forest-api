-- Phase 3 persistent forest area unlocks (docs/06_DOMAIN_MODEL.md → ForestProgression).
-- CreateTable
CREATE TABLE "forest_area_unlocks" (
    "user_id" UUID NOT NULL,
    "area_id" TEXT NOT NULL,
    "unlocked_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forest_area_unlocks_pkey" PRIMARY KEY ("user_id","area_id")
);

-- AddForeignKey
ALTER TABLE "forest_area_unlocks" ADD CONSTRAINT "forest_area_unlocks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- An unlock is permanent: it is never changed (deleting the user still removes it).
CREATE FUNCTION "forest_area_unlocks_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a forest area unlock cannot change';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "forest_area_unlocks_immutable" BEFORE UPDATE ON "forest_area_unlocks"
FOR EACH ROW EXECUTE FUNCTION "forest_area_unlocks_immutable"();
