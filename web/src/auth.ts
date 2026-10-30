import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { displayName } from "./authCopy.ts";

// Accounts (NOTES D-78): Supabase Auth, email + password. Supabase keeps the name, email, a password hash
// and its sign-in logs; video, face points, labels, history and the baseline stay in this browser.
// The publishable key is meant for browsers. Without both variables (a local run without a project) the app
// opens without an account, as it did before D-78.
const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const ACCOUNTS = Boolean(URL && KEY);

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient | null {
  if (!ACCOUNTS) return null;
  client ??= createClient(URL!, KEY!);
  return client;
}

export type Account = { id: string; email: string; name: string };

export function accountOf(session: Session | null): Account | null {
  const user = session?.user;
  if (!user) return null;
  return { id: user.id, email: user.email ?? "", name: displayName(user.email, user.user_metadata) };
}

// The stored session, refreshed if needed; null when signed out or without accounts.
export async function currentAccount(): Promise<Account | null> {
  const sb = supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return accountOf(data.session);
}

export async function signOut(): Promise<void> {
  await supabase()?.auth.signOut();
}

// Data kept per account on a shared laptop: the database and baseline key get the user's id.
export const scopeKey = (key: string, account: Account | null) => (account ? `${key}@${account.id}` : key);
