// Sign up / sign in copy and checks (NOTES D-78). Pure, so the messages are tested without Supabase.
// Errors are mapped by Supabase's error code, never by message text, which changes between versions.

export type AuthMode = "signin" | "signup";

export type AuthInput = { name: string; email: string; password: string };

export type FieldErrors = Partial<Record<keyof AuthInput, string>>;

export const MIN_PASSWORD = 8; // also set as the minimum in the Supabase dashboard (Authentication → Email)

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Client-side checks before any request: empty fields and an obviously malformed email.
export function validate(mode: AuthMode, input: AuthInput): FieldErrors {
  const errors: FieldErrors = {};
  if (mode === "signup" && input.name.trim() === "") errors.name = "Enter your name.";
  const email = input.email.trim();
  if (email === "") errors.email = "Enter your email address.";
  else if (!EMAIL.test(email)) errors.email = "Enter an email address like name@company.com.";
  if (input.password === "") errors.password = "Enter a password.";
  else if (mode === "signup" && input.password.length < MIN_PASSWORD) {
    errors.password = `Use at least ${MIN_PASSWORD} characters.`;
  }
  return errors;
}

export type AuthFailure = {
  message: string;
  field?: keyof AuthInput; // shown under this field instead of in the summary
  offerSignIn?: boolean; // "An account with this email already exists" → "Sign in instead"
  clearPassword?: boolean;
};

type ErrorLike = { code?: string; status?: number; name?: string; message?: string } | null | undefined;

export function authFailure(error: ErrorLike, online = true): AuthFailure {
  if (!online || error?.status === 0 || error?.name === "AuthRetryableFetchError") {
    return {
      message: "You're offline. Signing in needs the internet; the camera and your history don't.",
    };
  }
  switch (error?.code) {
    case "invalid_credentials":
      return { message: "Email or password is incorrect.", clearPassword: true };
    case "user_already_exists":
    case "email_exists":
      return { message: "An account with this email already exists.", offerSignIn: true };
    case "weak_password":
      return { message: `Use at least ${MIN_PASSWORD} characters, mixing letters and numbers.`, field: "password" };
    case "email_address_invalid":
    case "validation_failed":
      return { message: "Enter an email address like name@company.com.", field: "email" };
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return { message: "Too many attempts from this network. Wait a few minutes, then try again." };
    case "signup_disabled":
      return { message: "New accounts are paused right now. Try again later." };
    case "email_not_confirmed":
      return { message: "This email isn't confirmed yet. Ask the Equilibre team to confirm it." };
    default:
      if (error?.status === 429) {
        return { message: "Too many attempts from this network. Wait a few minutes, then try again." };
      }
      return { message: "Something went wrong on our side. Try again in a moment." };
  }
}

// The name shown in the app: the one given at sign up (or by Google), else the part of the email before "@".
export function displayName(email: string | undefined, metadata: Record<string, unknown> | undefined): string {
  for (const name of [metadata?.full_name, metadata?.name]) {
    if (typeof name === "string" && name.trim() !== "") return name.trim();
  }
  return email?.split("@")[0] ?? "there";
}

// Where Google sends the user back (NOTES D-79): this same page with only "next" kept, so the page can finish the
// sign-in and move on. Supabase accepts it only if the origin is in its Redirect URLs list.
export function oauthRedirect(href: string, next: string): string {
  const url = new URL(href);
  url.search = new URLSearchParams({ next }).toString();
  url.hash = "";
  return url.toString();
}

// What to say when the page comes back from Google without a session. Supabase reports the failure in the query
// (or, for some errors, the hash); "code" without a session means the exchange failed, e.g. another browser.
export function oauthFailure(search: string, hash: string): string | null {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const error = query.get("error") ?? fragment.get("error");
  if (error === "access_denied") return "Google sign-in was cancelled. Try again, or use your email.";
  if (error !== null || query.has("code")) {
    return "Google sign-in didn't finish. Try again in this browser, or use your email.";
  }
  return null;
}

// Where to go after signing in: back to the page that sent the user here, but only to our own pages.
export function nextPage(param: string | null): string {
  return param !== null && /^app\.html([?#].*)?$/.test(param) ? param : "app.html";
}
