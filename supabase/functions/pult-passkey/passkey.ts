// Вход по Face ID (passkey, WebAuthn). Логика без привязки к Supabase:
// библиотека и хранилище передаются снаружи, чтобы проверять её и в Deno, и в Node.

export type Cred = { id: string; public_key: string; counter: number; transports: string[] };
export type Store = {
  getCreds(): Promise<Cred[]>;
  saveCred(c: Cred & { device: string }): Promise<void>;
  setCounter(id: string, counter: number): Promise<void>;
  putChallenge(challenge: string, kind: "reg" | "auth"): Promise<void>;
  takeChallenge(challenge: string, kind: "reg" | "auth"): Promise<boolean>; // одноразовый, с просрочкой
};
export type Cfg = { rpID: string; origins: string[]; rpName: string };
// deno-lint-ignore no-explicit-any
export type Lib = Record<"generateRegistrationOptions" | "verifyRegistrationResponse" | "generateAuthenticationOptions" | "verifyAuthenticationResponse", (o: any) => Promise<any>>;

export const b64u = {
  enc: (u8: Uint8Array) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)),
};

// deno-lint-ignore no-explicit-any
function challengeOf(resp: any): string {
  const c = JSON.parse(new TextDecoder().decode(b64u.dec(String(resp?.response?.clientDataJSON ?? "")))).challenge;
  if (typeof c !== "string" || !c) throw new Error("нет вызова");
  return c;
}

export async function regOptions(lib: Lib, store: Store, cfg: Cfg, user: { id: string; email: string }) {
  const creds = await store.getCreds();
  const opts = await lib.generateRegistrationOptions({
    rpName: cfg.rpName, rpID: cfg.rpID,
    userName: user.email, userDisplayName: "Михаил", userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await store.putChallenge(opts.challenge, "reg");
  return opts;
}

// deno-lint-ignore no-explicit-any
export async function regVerify(lib: Lib, store: Store, cfg: Cfg, resp: any, device: string) {
  const ch = challengeOf(resp);
  if (!(await store.takeChallenge(ch, "reg"))) throw new Error("вызов просрочен, нажми ещё раз");
  const v = await lib.verifyRegistrationResponse({
    response: resp, expectedChallenge: ch, expectedOrigin: cfg.origins, expectedRPID: cfg.rpID, requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) throw new Error("ключ не прошёл проверку");
  const c = v.registrationInfo.credential;
  await store.saveCred({ id: c.id, public_key: b64u.enc(c.publicKey), counter: c.counter, transports: c.transports ?? [], device: device.slice(0, 80) });
}

export async function authOptions(lib: Lib, store: Store, cfg: Cfg) {
  // allowCredentials пустой: телефон сам предложит сохранённый ключ пульта
  const opts = await lib.generateAuthenticationOptions({ rpID: cfg.rpID, userVerification: "required" });
  await store.putChallenge(opts.challenge, "auth");
  return opts;
}

// deno-lint-ignore no-explicit-any
export async function authVerify(lib: Lib, store: Store, cfg: Cfg, resp: any) {
  const ch = challengeOf(resp);
  if (!(await store.takeChallenge(ch, "auth"))) throw new Error("вызов просрочен, нажми ещё раз");
  const cred = (await store.getCreds()).find((c) => c.id === resp?.id);
  if (!cred) throw new Error("этот ключ Face ID пульту не знаком");
  const v = await lib.verifyAuthenticationResponse({
    response: resp, expectedChallenge: ch, expectedOrigin: cfg.origins, expectedRPID: cfg.rpID, requireUserVerification: true,
    credential: { id: cred.id, publicKey: b64u.dec(cred.public_key), counter: cred.counter, transports: cred.transports },
  });
  if (!v.verified) throw new Error("Face ID не подтверждён");
  await store.setCounter(cred.id, v.authenticationInfo.newCounter);
}
