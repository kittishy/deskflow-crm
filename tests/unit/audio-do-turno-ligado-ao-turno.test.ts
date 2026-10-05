/**
 * A resposta em ÁUDIO está LIGADA ao turno (`lib/agent-engine/agent/inbound-turn.ts`).
 *
 * O gancho em si — a escada das recusas, a reciprocidade, o degrade para texto —
 * mora em `lib/agent-engine/agent/audio-do-turno.ts` e é testado lá, por
 * comportamento. O que este arquivo prende é a FIAÇÃO, que é a parte que estava
 * faltando: o gancho existia, testado, e NENHUM turno o chamava — o TTS estava
 * configurável na tela e inerte no runtime.
 *
 * Mesma técnica de `send-message-manda-foto-do-produto.test.ts`: a fiação mora
 * numa closure do `execute` sem ponto de injeção barato, então ela é presa pelo
 * texto da fonte nos dois pontos que a doutrina do gancho exige — preparar FORA
 * do lock do número (síntese e upload são rede) e enviar de DENTRO do `send` que
 * o guardrail chama (por fora, pularia opt-out, LGPD e o ritmo anti-ban).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { meioDaUltimaInbound } from "@/lib/agent-engine/agent/inbound-turn";
import type { LeadContextMessage } from "@/lib/agent-engine/edge/crm/get-lead-context";

const ler = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");

const FONTE = ler("lib/agent-engine/agent/inbound-turn.ts");
const corpoDoSend = (() => {
  const i = FONTE.indexOf("send_message: tool({");
  const j = FONTE.indexOf("update_lead_state: tool({", i);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return FONTE.slice(i, j);
})();

const msg = (m: Partial<LeadContextMessage> & Pick<LeadContextMessage, "direction" | "body">) =>
  ({ sent_at: "2026-10-02T10:00:00-03:00", ...m }) as LeadContextMessage;

describe("meioDaUltimaInbound — a chave da reciprocidade", () => {
  it("áudio do cliente devolve 'audio'", () => {
    expect(
      meioDaUltimaInbound([msg({ direction: "inbound", body: "[Mídia do cliente: um áudio]", type: "audio" })]),
    ).toBe("audio");
  });

  it("texto do cliente devolve 'texto', mesmo com legenda em mídia de outro tipo", () => {
    expect(meioDaUltimaInbound([msg({ direction: "inbound", body: "oi", type: "image" })])).toBe("texto");
    expect(meioDaUltimaInbound([msg({ direction: "inbound", body: "oi" })])).toBe("texto");
  });

  it("olha a ÚLTIMA inbound, ignorando a outbound do meio", () => {
    expect(
      meioDaUltimaInbound([
        msg({ direction: "inbound", body: "primeiro", type: "audio" }),
        msg({ direction: "outbound", body: "resposta do agente" }),
        msg({ direction: "inbound", body: "segundo" }),
      ]),
    ).toBe("texto");
  });

  it("sem inbound (ou com histórico vazio) devolve null — ausência não libera áudio", () => {
    expect(meioDaUltimaInbound([])).toBeNull();
    expect(meioDaUltimaInbound([msg({ direction: "outbound", body: "oi" })])).toBeNull();
  });
});

describe("send_message leva a resposta em áudio", () => {
  it("o áudio é preparado ANTES da cadeia (fora do lock) e a cadeia roda depois", () => {
    const prepara = corpoDoSend.indexOf("prepararAudioDoTurno(");
    const cadeia = corpoDoSend.indexOf("runBeforeSend(beforeSendArgs)");
    expect(prepara).toBeGreaterThan(-1);
    expect(cadeia).toBeGreaterThan(-1);
    expect(prepara).toBeLessThan(cadeia);
  });

  it("o áudio sai de DENTRO do `send` do guardrail, no lugar do texto", () => {
    const send = corpoDoSend.slice(corpoDoSend.indexOf("send: (finalBody: string) =>"));
    expect(send).toContain("enviar('', audioDoTurno.media)");
    // O texto continua sendo o caminho normal: o áudio é o desvio, não o padrão.
    expect(send).toContain("enviarComFotos(finalBody, fotosDoProduto,");
  });

  it("o áudio deita fora quando a cadeia reescreveu o corpo (o áudio prepared é do texto pré-cadeia)", () => {
    const send = corpoDoSend.slice(corpoDoSend.indexOf("send: (finalBody: string) =>"));
    expect(send).toMatch(/audioDoTurno\.ok\s*&&\s*finalBody\s*===\s*body/);
  });
});

describe("o worker monta as deps do TTS", () => {
  const worker = ler("workers/agent-worker/main.ts");

  it("injeta env, sintetizar, upload e log — as quatro chaves de lib/env.ts", () => {
    expect(worker).toMatch(/env:\s*\{[^}]*TTS_API_KEY[^}]*TTS_VOICE_ID/s);
    expect(worker).toMatch(/sintetizar:\s*sintetizarFala/);
    expect(worker).toMatch(/upload:\s*gravarAudioNoStorage\(/);
  });

  it("as deps entram no turnDeps compartilhado", () => {
    // O objeto literal inteiro: `[^}]*` não serviria, porque `crmCfg` abre um
    // objeto aninhado antes de `audio` aparecer.
    const objeto = worker.slice(
      worker.indexOf("const turnDeps: FollowupTurnDeps = {"),
      worker.indexOf('handlers.set("approved_reply"'),
    );
    expect(objeto).toMatch(/\baudio,/);
  });
});