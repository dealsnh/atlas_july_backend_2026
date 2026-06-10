import dotenv from "dotenv";

dotenv.config({ override: true });

process.env.NODE_ENV = "test";
delete process.env.API_KEY;

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("railway.internal")) {
  const user = process.env.PGUSER || process.env.USER || "postgres";
  process.env.DATABASE_URL = `postgresql://${user}@localhost:5432/atlas_test`;
}

process.env.DATABASE_SSL = "false";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-min-16-chars";
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@test.com";
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "TestPass123!";
