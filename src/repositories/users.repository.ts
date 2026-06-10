import { queryOne, execute } from "../db/query.js";
import type { UserRecord } from "../types/user.js";

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  return (
    (await queryOne<UserRecord>("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email])) ??
    null
  );
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  return (await queryOne<UserRecord>("SELECT * FROM users WHERE id = $1", [id])) ?? null;
}

export async function createUser(input: {
  id: string;
  email: string;
  passwordHash: string;
  name?: string | null;
}): Promise<UserRecord> {
  const row = await queryOne<UserRecord>(
    `INSERT INTO users (id, email, password_hash, name)
     VALUES ($1, LOWER($2), $3, $4)
     RETURNING *`,
    [input.id, input.email, input.passwordHash, input.name ?? null],
  );
  if (!row) throw new Error("Failed to create user");
  return row;
}

export async function countUsers(): Promise<number> {
  const row = await queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
  return row ? Number(row.count) : 0;
}

export async function deleteUserByEmail(email: string): Promise<void> {
  await execute("DELETE FROM users WHERE LOWER(email) = LOWER($1)", [email]);
}
