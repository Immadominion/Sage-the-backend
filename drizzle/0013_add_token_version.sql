-- 0013 — add token_version to support session revocation (logout / "log out everywhere")
-- See AURA_BACKEND_HARDENING_ROADMAP.md (H1).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "token_version" integer NOT NULL DEFAULT 0;
