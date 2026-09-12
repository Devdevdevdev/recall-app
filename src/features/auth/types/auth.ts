export type AuthUser = {
  email: string | null;
};

export type AuthSession = {
  user: AuthUser;
};

export type AuthRequestResult =
  { status: 'success'; requiresEmailConfirmation?: boolean } | { status: 'error'; message: string };
