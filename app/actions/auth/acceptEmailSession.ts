"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";

const tokensSchema = z.object({
  access_token: z.string().min(1).max(16000),
  refresh_token: z.string().min(1).max(4000),
});

/** Supabase's default invitation emails return an implicit session fragment.
 * Next server actions enforce same-origin requests. Tokens are verified by
 * GoTrue before the canonical server client writes its HttpOnly cookies.
 */
export async function acceptEmailSession(input: unknown): Promise<{ ok: boolean }> {
  const parsed = tokensSchema.safeParse(input);
  if (!parsed.success || await authRateLimited("email_session", null, AUTH_LIMITS.login)) {
    return { ok: false };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser(parsed.data.access_token);
  if (error || !data.user) return { ok: false };
  const { error: sessionError } = await supabase.auth.setSession(parsed.data);
  return { ok: !sessionError };
}
