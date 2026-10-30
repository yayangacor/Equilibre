import { describe, expect, it } from "vitest";
import { authFailure, displayName, MIN_PASSWORD, nextPage, oauthFailure, oauthRedirect, validate } from "./authCopy.ts";

describe("validate", () => {
  it("asks for every field on sign up", () => {
    expect(validate("signup", { name: " ", email: "", password: "" })).toEqual({
      name: "Enter your name.",
      email: "Enter your email address.",
      password: "Enter a password.",
    });
  });

  it("does not ask for a name or a length on sign in", () => {
    expect(validate("signin", { name: "", email: "a@b.co", password: "x" })).toEqual({});
  });

  it("rejects a malformed email and a short new password", () => {
    const errors = validate("signup", { name: "Ayu", email: "ayu@kantor", password: "1234567" });
    expect(errors.email).toMatch(/name@company\.com/);
    expect(errors.password).toBe(`Use at least ${MIN_PASSWORD} characters.`);
  });

  it("accepts a complete sign up (negative control)", () => {
    expect(validate("signup", { name: "Ayu", email: "ayu@kantor.id", password: "12345678" })).toEqual({});
  });
});

describe("authFailure", () => {
  it("maps Supabase codes, not message text", () => {
    expect(authFailure({ code: "invalid_credentials", message: "anything" })).toEqual({
      message: "Email or password is incorrect.",
      clearPassword: true,
    });
    expect(authFailure({ code: "user_already_exists" }).offerSignIn).toBe(true);
    expect(authFailure({ code: "weak_password" }).field).toBe("password");
  });

  it("treats a failed fetch or being offline as offline", () => {
    expect(authFailure({ name: "AuthRetryableFetchError", status: 0 }).message).toMatch(/offline/);
    expect(authFailure({ code: "invalid_credentials" }, false).message).toMatch(/offline/);
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(authFailure({ code: "unexpected_failure", status: 500 }).message).toMatch(/went wrong/);
    expect(authFailure({ status: 429 }).message).toMatch(/Too many attempts/);
  });
});

describe("displayName and nextPage", () => {
  it("prefers the sign-up name, then the email", () => {
    expect(displayName("ayu@kantor.id", { full_name: " Ayu Lestari " })).toBe("Ayu Lestari");
    expect(displayName("ayu@kantor.id", {})).toBe("ayu");
  });

  it("uses the name Google shares when there is no full_name", () => {
    expect(displayName("ayu@gmail.com", { name: "Ayu L" })).toBe("Ayu L");
    expect(displayName("ayu@gmail.com", { full_name: "", name: " " })).toBe("ayu");
  });

  it("only returns to our own app page", () => {
    expect(nextPage("app.html#insights")).toBe("app.html#insights");
    expect(nextPage("app.html?riwayat=demo#insights")).toBe("app.html?riwayat=demo#insights");
    expect(nextPage("app.htmlx")).toBe("app.html");
    expect(nextPage("https://evil.example")).toBe("app.html");
    expect(nextPage(null)).toBe("app.html");
  });
});

describe("Google sign-in (D-79)", () => {
  it("comes back to the same page with only next kept", () => {
    expect(oauthRedirect("https://equilibre-orcin.vercel.app/auth.html?next=app.html&x=1#signin", "app.html#insights")).toBe(
      "https://equilibre-orcin.vercel.app/auth.html?next=app.html%23insights",
    );
    expect(oauthRedirect("http://localhost:5173/auth.html", "app.html")).toBe("http://localhost:5173/auth.html?next=app.html");
  });

  it("says why Google sign-in did not finish", () => {
    expect(oauthFailure("?next=app.html&error=access_denied&error_code=access_denied", "")).toMatch(/cancelled/);
    expect(oauthFailure("?next=app.html", "#error=server_error&error_description=x")).toMatch(/didn't finish/);
    expect(oauthFailure("?next=app.html&code=abc", "")).toMatch(/didn't finish/);
  });

  it("stays quiet on a normal visit (negative control)", () => {
    expect(oauthFailure("?next=app.html", "#signin")).toBeNull();
    expect(oauthFailure("", "")).toBeNull();
  });
});
