import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: send }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { processarItem, recuperarTravados } from "./processar";
import type { LinhaDaFila } from "./consultas";

function database() {
  const updates: Array<Record<string, unknown>> = [];
  const builder = (table: string) => {
    let changed = false;
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      lt: () => query,
      update: (value: Record<string, unknown>) => {
        changed = true;
        updates.push(value);
        return query;
      },
      maybeSingle: async () => ({ data: row(table), error: null }),
      single: async () => ({ data: row(table), error: null }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: changed ? [{ id: "queue" }] : [], error: null }).then(resolve),
    };
    return query;
  };
  const row = (table: string) => {
    if (table === "organizations") return { status: "active" };
    if (table === "user_organizations") return { role: "agent" };
    if (table === "message_send_queue") return { status: "processing" };
    return {
      id: "message",
      conversation_id: "conversation",
      body: "Updated individual message",
      type: "text",
      sent_by_user_id: "sender",
      reply_to_message_id: null,
    };
  };
  return { admin: { from: builder } as unknown as SupabaseClient, updates };
}

const item = {
  id: "queue",
  message_id: "message",
  organization_id: "organization",
  contact_id: "contact",
  conversation_id: "conversation",
  status: "processing",
  tentativas: 1,
  max_tentativas: 3,
  claim_token: "claim-token",
} as LinhaDaFila;

describe("queue delivery safety", () => {
  it("does not replay an interrupted attempt with an unknown remote outcome", async () => {
    const { admin, updates } = database();
    await recuperarTravados(admin, new Date("2026-10-07T10:00:00Z"));
    expect(updates[0]).toMatchObject({ status: "failed", erro: "delivery_outcome_unknown" });
    expect(updates.some((update) => update.status === "pending")).toBe(false);
  });

  it("sends using the existing message identity and original human author", async () => {
    send.mockResolvedValueOnce({ id: "message", status: "sent" });
    const { admin, updates } = database();
    expect(await processarItem(admin, item)).toBe("sent");
    expect(send).toHaveBeenLastCalledWith(
      admin,
      expect.objectContaining({ internalMessageId: "message", actor: { type: "user", id: "sender" } }),
      expect.objectContaining({ body: "Updated individual message" }),
    );
    expect(updates.at(-1)).toMatchObject({ status: "sent" });
  });

  it("does not automatically resend after a provider timeout", async () => {
    send.mockRejectedValueOnce(new Error("timeout"));
    const { admin, updates } = database();
    expect(await processarItem(admin, item)).toBe("failed");
    expect(updates.at(-1)).toMatchObject({ status: "failed", erro: "delivery_not_confirmed" });
    expect(updates.some((update) => update.status === "pending")).toBe(false);
  });

  it("retries a KNOWN refusal while attempts remain", async () => {
    // O canal respondeu e disse que recusou: nada foi entregue, repetir é seguro.
    send.mockRejectedValueOnce(new Error("missing_phone_number"));
    const { admin, updates } = database();
    expect(await processarItem(admin, item)).toBe("retry");
    const ultimo = updates.at(-1) as Record<string, unknown>;
    expect(ultimo).toMatchObject({ status: "pending", erro: "missing_phone_number" });
    // O token volta a nulo e o lock é solto: só o próximo tick reivindica de novo.
    expect(ultimo.claim_token).toBeNull();
    expect(ultimo.locked_by).toBeNull();
    // E a espera cresce — uma recusa de canal não pode virar rajada.
    const espera = new Date(String(ultimo.scheduled_at)).getTime() - Date.now();
    expect(espera).toBeGreaterThan(0);
  });

  it("stops retrying a known refusal once the attempts run out", async () => {
    send.mockRejectedValueOnce(new Error("missing_phone_number"));
    const { admin, updates } = database();
    const esgotado = { ...item, tentativas: item.max_tentativas } as LinhaDaFila;
    expect(await processarItem(admin, esgotado)).toBe("failed");
    expect(updates.at(-1)).toMatchObject({ status: "failed", erro: "missing_phone_number" });
    expect(updates.some((update) => update.status === "pending")).toBe(false);
  });

  it("never replays a generic channel error, which is an unknown outcome", async () => {
    // O código genérico que o adapter lança é o catch-all: NÃO prova recusa.
    // Pode ter saído.
    send.mockRejectedValueOnce(new Error("adapter_send_failed"));
    const { admin, updates } = database();
    expect(await processarItem(admin, item)).toBe("failed");
    expect(updates.some((update) => update.status === "pending")).toBe(false);
  });
});
