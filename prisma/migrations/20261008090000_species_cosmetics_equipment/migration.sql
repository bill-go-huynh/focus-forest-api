-- A4.3 species, variants, cosmetics, and equipment. Additive only: no existing row is changed
-- (archived and growing trees keep their species).

-- A cosmetic goes only into the slot of its own type: equipment references (id, type).
CREATE UNIQUE INDEX "cosmetic_definitions_id_type_key" ON "cosmetic_definitions"("id", "type");

-- What the user shows: one owned cosmetic per slot (the slots are the cosmetic types; the
-- profile frame belongs to the profile only). Presentation state, apart from ownership.
CREATE TABLE "user_equipment" (
    "user_id" UUID NOT NULL,
    "slot" "cosmetic_type" NOT NULL,
    "cosmetic_id" TEXT NOT NULL,
    "equipped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_equipment_pkey" PRIMARY KEY ("user_id","slot")
);

ALTER TABLE "user_equipment" ADD CONSTRAINT "user_equipment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_equipment" ADD CONSTRAINT "user_equipment_cosmetic_id_slot_fkey" FOREIGN KEY ("cosmetic_id", "slot") REFERENCES "cosmetic_definitions"("id", "type") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Only an owned cosmetic is equipped: a system cosmetic (owned by everyone) or one with an
-- ownership row. Ownership is never removed, so an equipped item stays valid.
CREATE FUNCTION "user_equipment_owned"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "cosmetic_definitions" c WHERE c."id" = NEW."cosmetic_id" AND c."source" = 'system'
  ) AND NOT EXISTS (
    SELECT 1 FROM "user_cosmetics" u WHERE u."user_id" = NEW."user_id" AND u."cosmetic_id" = NEW."cosmetic_id"
  ) THEN
    RAISE EXCEPTION 'only an owned cosmetic can be equipped';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "user_equipment_owned" BEFORE INSERT OR UPDATE ON "user_equipment" FOR EACH ROW EXECUTE FUNCTION "user_equipment_owned"();

-- A system cosmetic is owned by every user (like the signature species), so it stays active,
-- system, and defined forever.
CREATE FUNCTION "system_cosmetic_permanent"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."source" <> 'system' OR NEW."status" <> 'active' THEN
    RAISE EXCEPTION 'a system cosmetic is owned by everyone and cannot be retired or removed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "cosmetic_definitions_system_permanent" BEFORE UPDATE OR DELETE ON "cosmetic_definitions" FOR EACH ROW WHEN (OLD."source" = 'system') EXECUTE FUNCTION "system_cosmetic_permanent"();

-- Content seed: A4.3 species and cosmetics. Each species is unlocked by an achievement already
-- seeded (A4.1), shares the one tree framework, and differs only in how the app draws it (by
-- its id). Moon Tree and Crystal Tree are not defined: the product names no condition for them,
-- and no content source fits a tree nobody can earn yet. Cosmetics decorate the garden only:
-- nothing that imitates an earned layer of the tree (blossoms, fruit, glow, fauna).
INSERT INTO "tree_species" ("id", "rarity", "source", "achievement_id", "availability", "status", "name", "description", "sort_order") VALUES
  ('oak', 'common', 'achievement', 'first-session', 'permanent', 'active', 'Oak', 'A sturdy oak, grown from your first focus session.', 20),
  ('sakura', 'common', 'achievement', 'focus-hours:10', 'permanent', 'active', 'Sakura', 'A cherry tree with arching branches.', 30),
  ('pine', 'common', 'achievement', 'focus-streak:7', 'permanent', 'active', 'Pine', 'An evergreen pine that keeps its needles all year.', 40),
  ('maple', 'common', 'achievement', 'focus-hours:50', 'permanent', 'active', 'Maple', 'A maple whose leaves turn warm red and orange.', 50),
  ('bonsai', 'rare', 'achievement', 'focus-streak:30', 'permanent', 'active', 'Bonsai', 'A small, patient tree shaped with care.', 60),
  ('fantasy', 'rare', 'achievement', 'focus-hours:100', 'permanent', 'active', 'Fantasy Tree', 'A tree from a quieter, stranger forest.', 70);

INSERT INTO "tree_species" ("id", "base_species_id", "rarity", "source", "achievement_id", "availability", "status", "name", "description", "sort_order") VALUES
  ('golden-sakura', 'sakura', 'legendary', 'achievement', 'focus-hours:500', 'permanent', 'active', 'Golden Sakura', 'A rare sakura with golden blossoms.', 80),
  ('ancient-pine', 'pine', 'legendary', 'achievement', 'focus-streak:100', 'permanent', 'active', 'Ancient Pine', 'A rare pine, weathered by many seasons.', 90);

INSERT INTO "cosmetic_definitions" ("id", "type", "rarity", "source", "achievement_id", "availability", "status", "name", "description", "artwork_id", "sort_order") VALUES
  ('meadow', 'background', 'common', 'system', NULL, 'permanent', 'active', 'Meadow', 'Soft green hills behind your forest.', 'meadow', 10),
  ('mossy-stones', 'decoration', 'common', 'system', NULL, 'permanent', 'active', 'Mossy Stones', 'A few quiet stones on the ground.', 'mossy-stones', 20),
  ('stone-lantern', 'decoration', 'common', 'achievement', 'focus-hours:50', 'permanent', 'active', 'Stone Lantern', 'A small stone lantern by the path.', 'stone-lantern', 30),
  ('misty-hills', 'background', 'rare', 'achievement', 'focus-hours:100', 'permanent', 'active', 'Misty Hills', 'Far hills in a morning mist.', 'misty-hills', 40),
  ('twig-frame', 'profile_frame', 'rare', 'achievement', 'focus-streak:30', 'permanent', 'active', 'Twig Frame', 'A frame of woven twigs for your profile.', 'twig-frame', 50);
-- End of content seed.
