-- Rename legacy column sentinel_wallet_address → seal_wallet_address
-- This is a no-op on fresh databases (column is already named seal_wallet_address).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name = 'sentinel_wallet_address'
  ) THEN
    ALTER TABLE users RENAME COLUMN sentinel_wallet_address TO seal_wallet_address;
  END IF;
END $$;
