import "dotenv/config";

process.env.NODE_ENV = "test";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else if (
  !process.env.DATABASE_URL ||
  process.env.DATABASE_URL.includes("railway.internal")
) {
  const user = process.env.PGUSER || process.env.USER || "postgres";
  process.env.DATABASE_URL = `postgresql://${user}@localhost:5432/atlas_test`;
}

process.env.DATABASE_SSL = "false";
