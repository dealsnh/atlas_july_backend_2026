import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";
import { ApiError } from "./api-error.js";

export type JwtPayload = {
  sub: string;
  email: string;
};

function getSecret(): Uint8Array {
  if (!env.JWT_SECRET) {
    throw ApiError.internal("JWT_SECRET is not configured");
  }
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function signAccessToken(payload: JwtPayload): Promise<string> {
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(env.JWT_EXPIRES_IN)
    .sign(getSecret());
}

export async function verifyAccessToken(token: string): Promise<JwtPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const sub = payload.sub;
    const email = payload.email;
    if (typeof sub !== "string" || typeof email !== "string") {
      throw ApiError.unauthorized("Invalid token");
    }
    return { sub, email };
  } catch {
    throw ApiError.unauthorized("Invalid or expired token");
  }
}
