import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import {
  countUsers,
  createUser,
  findUserByEmail,
  findUserById,
} from "../repositories/users.repository.js";
import type { AuthResult, PublicUser, UserRecord } from "../types/user.js";
import { ApiError } from "../utils/api-error.js";
import { signAccessToken } from "../utils/jwt.js";
import { logger } from "../utils/logger.js";

const SALT_ROUNDS = 12;

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at.toISOString(),
  };
}

async function issueToken(user: UserRecord): Promise<AuthResult> {
  const token = await signAccessToken({ sub: user.id, email: user.email });
  return { user: toPublicUser(user), token };
}

export async function signupUser(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<AuthResult> {
  const existing = await findUserByEmail(input.email);
  if (existing) {
    throw ApiError.conflict("An account with this email already exists");
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
  const user = await createUser({
    id: randomUUID(),
    email: input.email,
    passwordHash,
    name: input.name?.trim() || null,
  });

  return issueToken(user);
}

export async function loginUser(input: { email: string; password: string }): Promise<AuthResult> {
  const user = await findUserByEmail(input.email);
  if (!user) {
    throw ApiError.unauthorized("Invalid email or password");
  }

  const valid = await bcrypt.compare(input.password, user.password_hash);
  if (!valid) {
    throw ApiError.unauthorized("Invalid email or password");
  }

  return issueToken(user);
}

export async function getUserById(id: string): Promise<PublicUser> {
  const user = await findUserById(id);
  if (!user) {
    throw ApiError.unauthorized("User not found");
  }
  return toPublicUser(user);
}

export async function seedAdminUserIfNeeded(): Promise<void> {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return;

  const total = await countUsers();
  const existing = await findUserByEmail(env.ADMIN_EMAIL);
  if (existing) return;

  const passwordHash = await bcrypt.hash(env.ADMIN_PASSWORD, SALT_ROUNDS);
  try {
    await createUser({
      id: randomUUID(),
      email: env.ADMIN_EMAIL,
      passwordHash,
      name: "Admin",
    });
    logger.info(
      { email: env.ADMIN_EMAIL, totalUsersBefore: total },
      "Seeded admin user from ADMIN_EMAIL",
    );
  } catch (err) {
    // Hot-reload can race two inits; user may exist by the time INSERT runs
    if (err instanceof Error && "code" in err && (err as { code: string }).code === "23505") {
      return;
    }
    throw err;
  }
}
