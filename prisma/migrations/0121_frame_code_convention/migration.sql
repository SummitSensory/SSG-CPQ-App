-- 0121_frame_code_convention
--
-- The frame naming convention becomes data a system admin edits (Administration ->
-- Frame naming): letters, quantities, feature order and where the dimensions print.
-- One row per saved version, append-only, because each proposal stamps the version
-- that named it. No rows are seeded: version 1 is the default in code.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- CreateTable
CREATE TABLE IF NOT EXISTS "FrameCodeConvention" (
    "id" TEXT NOT NULL,
    "productLine" TEXT NOT NULL DEFAULT 'ADVENTURE',
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FrameCodeConvention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FrameCodeConvention_productLine_version_key" ON "FrameCodeConvention"("productLine", "version");
