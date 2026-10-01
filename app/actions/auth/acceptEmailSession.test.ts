import { beforeEach, expect, it, vi } from "vitest";
import { acceptEmailSession } from "./acceptEmailSession";

const auth = vi.hoisted(() => ({ getUser: vi.fn(), setSession: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ auth })) }));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: vi.fn(async () => false), AUTH_LIMITS: { login: {} },
}));
beforeEach(() => {
  vi.clearAllMocks();
  auth.getUser.mockResolvedValue({ data: { user: { id: "owner" } }, error: null });
  auth.setSession.mockResolvedValue({ error: null });
});
it("rejects invalid provider tokens without setting cookies", async () => {
  auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: "invalid" } });
  expect(await acceptEmailSession({ access_token: "invalid", refresh_token: "refresh" })).toEqual({ ok: false });
  expect(auth.setSession).not.toHaveBeenCalled();
});
it("sets the session only after the provider verifies the user", async () => {
  const tokens = { access_token: "signed", refresh_token: "refresh" };
  expect(await acceptEmailSession(tokens)).toEqual({ ok: true });
  expect(auth.getUser).toHaveBeenCalledWith("signed");
  expect(auth.setSession).toHaveBeenCalledWith(tokens);
});
