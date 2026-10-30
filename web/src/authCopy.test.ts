import { describe, expect, it } from "vitest";
import { authFailure, displayName, MIN_PASSWORD, nextPage, validate } from "./authCopy.ts";

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

  it("only returns to our own app page", () => {
    expect(nextPage("app.html#insights")).toBe("app.html#insights");
    expect(nextPage("https://evil.example")).toBe("app.html");
    expect(nextPage(null)).toBe("app.html");
  });
});
