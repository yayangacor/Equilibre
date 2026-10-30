import "./design/tokens.css";
import "./auth.css";
import { ACCOUNTS, accountOf, googleEnabled, supabase } from "./auth.ts";
import {
  authFailure,
  MIN_PASSWORD,
  nextPage,
  oauthFailure,
  oauthRedirect,
  validate,
  type AuthInput,
  type AuthMode,
  type FieldErrors,
} from "./authCopy.ts";

// Sign up / sign in (NOTES D-78), as the auth research recommended: one form for both modes, errors by
// Supabase code under the field or in a summary, the password never cleared except after a wrong password,
// and a "what we keep" panel next to the button. The visual on the right is a synthetic loop, never the camera.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const next = nextPage(params.get("next"));

const form = byId<HTMLFormElement>("auth-form");
const fields = {
  name: byId<HTMLInputElement>("auth-name"),
  email: byId<HTMLInputElement>("auth-email"),
  password: byId<HTMLInputElement>("auth-password"),
};
const errorsEl: Record<keyof AuthInput, HTMLElement> = {
  name: byId("auth-name-error"),
  email: byId("auth-email-error"),
  password: byId("auth-password-error"),
};
const submit = byId<HTMLButtonElement>("auth-submit");
const submitText = byId("auth-submit-text");
const summary = byId("auth-summary");
const summaryText = byId("auth-summary-text");
const switchToSignIn = byId<HTMLButtonElement>("auth-switch-signin");
const offline = byId("auth-offline");
const showButton = byId<HTMLButtonElement>("auth-show");
const rule = byId("auth-password-rule");
const forgot = byId<HTMLButtonElement>("auth-forgot");
const forgotNote = byId("auth-forgot-note");
const oauth = byId("auth-oauth");
const google = byId<HTMLButtonElement>("auth-google");
const googleText = byId("auth-google-text");

const COPY: Record<AuthMode, { eyebrow: string; title: string; sub: string; submit: string; busy: string; cross: string; link: string; doc: string }> = {
  signup: {
    eyebrow: "Create account",
    title: "Create your account",
    sub: "Takes a minute. Your camera stays off until you turn it on.",
    submit: "Create account",
    busy: "Creating account…",
    cross: "Already have an account?",
    link: "Sign in",
    doc: "Create account · Equilibre",
  },
  signin: {
    eyebrow: "Sign in",
    title: "Welcome back",
    sub: "Sign in to continue to your dashboard.",
    submit: "Sign in",
    busy: "Signing in…",
    cross: "New to Equilibre?",
    link: "Create an account",
    doc: "Sign in · Equilibre",
  },
};

let mode: AuthMode = location.hash === "#signin" ? "signin" : "signup";
let busy = false;

function setMode(next: AuthMode) {
  mode = next;
  const copy = COPY[mode];
  document.body.dataset.mode = mode;
  document.title = copy.doc;
  byId("auth-eyebrow").textContent = copy.eyebrow;
  byId("auth-title").textContent = copy.title;
  byId("auth-sub").textContent = copy.sub;
  submitText.textContent = copy.submit;
  byId("auth-cross-text").textContent = copy.cross;
  const link = byId<HTMLAnchorElement>("auth-cross-link");
  link.textContent = copy.link;
  link.href = mode === "signup" ? "#signin" : "#signup";
  for (const el of document.querySelectorAll<HTMLElement>("[data-for]")) el.hidden = el.dataset.for !== mode;
  fields.password.autocomplete = mode === "signup" ? "new-password" : "current-password";
  fields.email.autocomplete = mode === "signup" ? "email" : "username";
  forgotNote.hidden = true;
  clearErrors();
  renderRule();
}

function clearErrors() {
  summary.hidden = true;
  switchToSignIn.hidden = true;
  for (const key of Object.keys(errorsEl) as (keyof AuthInput)[]) {
    errorsEl[key].hidden = true;
    fields[key].removeAttribute("aria-invalid");
  }
}

function showFieldErrors(errors: FieldErrors): boolean {
  let first: HTMLInputElement | null = null;
  for (const key of ["name", "email", "password"] as const) {
    const message = errors[key];
    if (!message) continue;
    errorsEl[key].textContent = message;
    errorsEl[key].hidden = false;
    fields[key].setAttribute("aria-invalid", "true");
    first ??= fields[key];
  }
  first?.focus();
  return first !== null;
}

function showSummary(message: string, offerSignIn = false) {
  summaryText.textContent = message;
  switchToSignIn.hidden = !offerSignIn;
  summary.hidden = false;
}

function renderRule() {
  rule.dataset.ok = fields.password.value.length >= MIN_PASSWORD ? "1" : "0";
}

function setBusy(on: boolean) {
  busy = on;
  submit.dataset.busy = on ? "1" : "0";
  submit.setAttribute("aria-busy", String(on));
  submitText.textContent = on ? COPY[mode].busy : COPY[mode].submit;
}

function renderOnline() {
  offline.hidden = navigator.onLine;
}

async function onSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (busy) return;
  clearErrors();
  const input: AuthInput = { name: fields.name.value, email: fields.email.value.trim(), password: fields.password.value };
  if (showFieldErrors(validate(mode, input))) return;
  const sb = supabase();
  if (!sb) return;
  if (!navigator.onLine) {
    showSummary(authFailure(null, false).message);
    return;
  }
  setBusy(true);
  try {
    const { data, error } =
      mode === "signup"
        ? await sb.auth.signUp({
            email: input.email,
            password: input.password,
            options: { data: { full_name: input.name.trim() } },
          })
        : await sb.auth.signInWithPassword({ email: input.email, password: input.password });
    if (error) {
      const failure = authFailure(error, navigator.onLine);
      if (failure.clearPassword) fields.password.value = "";
      if (failure.field) showFieldErrors({ [failure.field]: failure.message });
      else showSummary(failure.message, failure.offerSignIn);
      if (params.get("debug") === "1") summaryText.textContent += ` (${error.code ?? error.status ?? "error"})`;
      return;
    }
    if (!data.session) {
      // "Confirm email" is on in the project: nothing to sign in with yet.
      showSummary("Check your inbox to confirm your email, then sign in.");
      return;
    }
    location.replace(next);
  } catch (err) {
    showSummary(authFailure(err as { name?: string; status?: number }, navigator.onLine).message);
  } finally {
    setBusy(false);
  }
}

// Google (D-79): the browser leaves for Google and comes back to this page with "?code=…"; start() finishes it.
async function onGoogle() {
  if (busy) return;
  clearErrors();
  const sb = supabase();
  if (!sb) return;
  if (!navigator.onLine) {
    showSummary(authFailure(null, false).message);
    return;
  }
  google.setAttribute("aria-busy", "true");
  googleText.textContent = "Opening Google…";
  const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: oauthRedirect(location.href, next) } });
  if (error) {
    google.removeAttribute("aria-busy");
    googleText.textContent = "Continue with Google";
    showSummary(authFailure(error, navigator.onLine).message);
  }
}

form.addEventListener("submit", (event) => void onSubmit(event));
google.addEventListener("click", () => void onGoogle());
switchToSignIn.addEventListener("click", () => {
  location.hash = "#signin";
  fields.password.value = "";
  fields.password.focus();
});
window.addEventListener("hashchange", () => setMode(location.hash === "#signin" ? "signin" : "signup"));
showButton.addEventListener("click", () => {
  const show = fields.password.type === "password";
  fields.password.type = show ? "text" : "password";
  showButton.textContent = show ? "Hide" : "Show";
  showButton.setAttribute("aria-label", show ? "Hide password" : "Show password");
});
fields.password.addEventListener("input", renderRule);
forgot.addEventListener("click", () => (forgotNote.hidden = !forgotNote.hidden));
window.addEventListener("online", renderOnline);
window.addEventListener("offline", renderOnline);

// ── The synthetic readout on the right: a face of dots, an EAR trace, a state that changes and says why ──

type Pt = { x: number; y: number };
const SVG = "http://www.w3.org/2000/svg";

function ellipse(cx: number, cy: number, rx: number, ry: number, n: number, from = 0, to = Math.PI * 2): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = from + ((to - from) * i) / (to - from >= Math.PI * 2 ? n : n - 1);
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
}

function startVisual() {
  const face = byId("demo-face") as unknown as SVGSVGElement;
  const tracePath = byId("demo-trace-path") as unknown as SVGPathElement;
  const chip = byId("demo-chip");
  const chipText = byId("demo-chip-text");
  const ear = byId("demo-ear");
  const why = byId("demo-why");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const groups = {
    outline: ellipse(160, 150, 92, 118, 46),
    browL: ellipse(122, 104, 26, 10, 8, Math.PI * 1.1, Math.PI * 1.9),
    browR: ellipse(198, 104, 26, 10, 8, Math.PI * 1.1, Math.PI * 1.9),
    eyeL: ellipse(122, 126, 18, 8, 14),
    eyeR: ellipse(198, 126, 18, 8, 14),
    nose: Array.from({ length: 6 }, (_, i) => ({ x: 160, y: 128 + i * 9 })),
    lips: ellipse(160, 206, 30, 9, 18),
  };
  const dots = new Map<string, SVGCircleElement[]>();
  for (const [name, points] of Object.entries(groups)) {
    dots.set(
      name,
      points.map((p) => {
        const c = document.createElementNS(SVG, "circle");
        c.setAttribute("cx", String(p.x));
        c.setAttribute("cy", String(p.y));
        c.setAttribute("r", name.startsWith("eye") ? "2.1" : "1.6");
        c.setAttribute("class", name.startsWith("eye") ? "pt eye" : "pt");
        face.append(c);
        return c;
      }),
    );
  }
  // Leader lines from the features to their readouts.
  const leaders: [Pt, Pt, string, string][] = [
    [{ x: 104, y: 126 }, { x: 12, y: 60 }, "EAR L", "l"],
    [{ x: 216, y: 126 }, { x: 236, y: 60 }, "EAR R", "r"],
    [{ x: 190, y: 206 }, { x: 236, y: 262 }, "JAW", "j"],
  ];
  const labels = new Map<string, SVGTextElement>();
  for (const [from, to, name, key] of leaders) {
    const line = document.createElementNS(SVG, "polyline");
    line.setAttribute("points", `${from.x},${from.y} ${to.x + (to.x < from.x ? 72 : 0)},${to.y} ${to.x},${to.y}`);
    line.setAttribute("class", "leader");
    const text = document.createElementNS(SVG, "text");
    text.setAttribute("x", String(to.x));
    text.setAttribute("y", String(to.y - 6));
    text.setAttribute("class", "leader-text");
    text.textContent = `${name} 0.29`;
    face.append(line, text);
    labels.set(key, text);
  }

  const scenes = [
    { state: "normal", text: "Normal", ear: 0.29, blinkEvery: 3.4, blinkMs: 160, why: "No signs of tiredness in the last minute." },
    { state: "mild", text: "Mildly tired", ear: 0.23, blinkEvery: 2.2, blinkMs: 420, why: "Slow blinks: 2.1× your baseline length." },
  ] as const;
  const history: number[] = [];
  let scene = 0;
  let sceneStart = performance.now();
  let lastBlink = 0;
  let lastSample = 0;

  const setScene = (i: number) => {
    scene = i;
    const s = scenes[i];
    chip.dataset.state = s.state;
    chipText.textContent = s.text;
    why.textContent = s.why;
  };
  setScene(0);

  const frame = (now: number) => {
    if (now - sceneStart > 7000) {
      setScene((scene + 1) % scenes.length);
      sceneStart = now;
    }
    const s = scenes[scene];
    if (now - lastBlink > s.blinkEvery * 1000) lastBlink = now;
    const t = (now - lastBlink) / s.blinkMs;
    const closed = t < 1 ? Math.sin(Math.PI * t) : 0; // 0 open → 1 shut → 0
    const open = s.ear * (1 - 0.82 * closed) + Math.sin(now / 900) * 0.004;
    for (const name of ["eyeL", "eyeR"] as const) {
      groups[name].forEach((p, i) => {
        dots.get(name)![i].setAttribute("cy", String(126 + (p.y - 126) * (1 - closed * 0.92)));
      });
    }
    if (now - lastSample > 100) {
      lastSample = now;
      history.push(open);
      if (history.length > 200) history.shift();
      const step = 320 / 199;
      tracePath.setAttribute(
        "d",
        history.map((v, i) => `${i === 0 ? "M" : "L"}${(320 - (history.length - 1 - i) * step).toFixed(1)},${(80 - v * 200).toFixed(1)}`).join(""),
      );
      ear.textContent = open.toFixed(2);
      labels.get("l")!.textContent = `EAR L ${(open + 0.004).toFixed(2)}`;
      labels.get("r")!.textContent = `EAR R ${open.toFixed(2)}`;
      labels.get("j")!.textContent = `JAW ${(0.05 + Math.max(0, Math.sin(now / 2600)) * 0.03).toFixed(2)}`;
    }
    // requestAnimationFrame pauses by itself in a hidden tab.
    if (!still) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function start() {
  setMode(mode);
  renderOnline();
  startVisual();
  if (!ACCOUNTS) {
    byId("auth-unconfigured").hidden = false;
    form.hidden = true;
    return;
  }
  // Already signed in on this browser, or just back from Google (the client exchanged "?code=…"): straight on.
  const { data } = await supabase()!.auth.getSession();
  if (accountOf(data.session)) {
    location.replace(next);
    return;
  }
  const failure = oauthFailure(location.search, location.hash);
  if (failure) {
    showSummary(failure);
    history.replaceState(null, "", oauthRedirect(location.href, next));
  }
  if (await googleEnabled()) oauth.hidden = false;
}

void start();
