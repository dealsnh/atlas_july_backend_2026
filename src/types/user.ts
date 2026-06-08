export type UserRecord = {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  created_at: Date;
  updated_at: Date;
};

export type PublicUser = {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
};

export type AuthResult = {
  user: PublicUser;
  token: string;
};
