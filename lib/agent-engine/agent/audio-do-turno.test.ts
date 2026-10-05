import { describe, expect, it, vi } from "vitest";

import { sintetizarFala } from "@/lib/audio/sintese";
import { wahaSendPlanFor } from "@/lib/waha/media-send";

import { corpoDoEnvio } from "../edge/crm/send-message";

import {
  prepararAudioDoTurno,
  preferenciasDeVozDoAgente,
  TETO_DO_TEXTO_PARA_AUDIO,
  type AudioDoTurnoDeps,
  type MeioDoCliente,
} from "./audio-do-turno";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CONVERSA = "cccccccc-0000-4000-8000-000000000001";
const AGENTE = "dddddddd-0000-4000-8000-000000000001";

const LINHA = { tts_enabled: true, tts_provider: "fish", tts_voice_id: "voz-da-casa" };

/** Preferência de voz como a migration 0506 a deixa no `ai_agents`. */
function banco(linha: Partial<typeof LINHA> | null = LINHA) {
  const query = vi.fn(async (_sql: string, valores: unknown[]) => ({
    rows: linha ? [linha] : [],
    valores,
  }));
  return { db: { query } as never, query };
}

function deps(over: Partial<AudioDoTurnoDeps> = {}): AudioDoTurnoDeps {
  return {
    env: { TTS_API_KEY: "sk_tts", TTS_BASE_URL: "", TTS_MODEL: "", TTS_VOICE_ID: "" },
    sintetizar: vi.fn(async () => ({
      bytes: new Uint8Array([9, 9]),
      mime: "audio/mpeg",
      extensao: "mp3",
    })),
    upload: vi.fn(async () => true),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

const CHAMADA = {
  tenantId: ORG,
  conversationId: CONVERSA,
  agentId: AGENTE,
  texto: "Oi! Passa aqui hoje às 14h?",
  /** o cliente falou por áudio: aí a resposta em áudio é bem-vinda */
  meioDoCliente: 'audio' as MeioDoCliente,
};

describe("preferenciasDeVozDoAgente — a linha é do agente e só dela", () => {
  it("lê a preferência da organização na própria linha do agente", async () => {
    const { db, query } = banco();

    const p = await preferenciasDeVozDoAgente(db, { tenantId: ORG, agentId: AGENTE });

    // Filtrar por organization_id: sem isso, o id do agente sozinho leria linha alheia.
    expect(query.mock.calls[0]?.[1]).toEqual([ORG, AGENTE]);
    expect(p).toEqual({ enabled: true, provider: "fish", voiceId: "voz-da-casa" });
  });

  it("agente inexistente ou sem id é preferences nulas — e ninguém responde com erro", async () => {
    const { db } = banco(null);
    expect(await preferenciasDeVozDoAgente(db, { tenantId: ORG, agentId: AGENTE })).toBeNull();
    expect(await preferenciasDeVozDoAgente(db, { tenantId: ORG, agentId: null })).toBeNull();
  });
});

describe("prepararAudioDoTurno — quando a resposta sai como ÁUDIO", () => {
  it("sintetiza, guarda na pasta da conversa e devolve a mídia como kind audio", async () => {
    const { db } = banco();
    const d = deps();

    const r = await prepararAudioDoTurno(db, d, CHAMADA);

    expect(r.ok).toBe(true);
    expect(r.ok && r.media).toMatchObject({ kind: "audio", mime: "audio/mpeg" });
    expect(r.ok && r.media.storagePath).toMatch(
      new RegExp(`^${ORG}/${CONVERSA}/tts-[0-9a-f]{16}\\.mp3$`),
    );
    // O provedor foi chamado com a voz da organização e o texto final do turno.
    expect(d.sintetizar).toHaveBeenCalledWith(
      "Oi! Passa aqui hoje às 14h?",
      expect.objectContaining({
        provider: "fish",
        credenciais: expect.objectContaining({ apiKey: "sk_tts", voiceId: "voz-da-casa" }),
      }),
    );
    expect(d.upload).toHaveBeenCalledTimes(1);
  });

  it("a preferência da organização vence a voz do .env; o .env é só o piso", async () => {
    const { db } = banco({ ...LINHA, tts_voice_id: "voz-da-org" });
    const d = deps({ env: { TTS_API_KEY: "sk_tts", TTS_BASE_URL: "", TTS_MODEL: "", TTS_VOICE_ID: "voz-do-env" } });

    await prepararAudioDoTurno(db, d, CHAMADA);

    expect(d.sintetizar).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credenciais: expect.objectContaining({ voiceId: "voz-da-org" }) }),
    );
  });

  it("provedor da organização também vence o default do .env", async () => {
    const { db } = banco({ ...LINHA, tts_provider: "elevenlabs" });
    const d = deps({ env: { TTS_API_KEY: "sk_tts", TTS_BASE_URL: "", TTS_MODEL: "", TTS_VOICE_ID: "" } });

    await prepararAudioDoTurno(db, d, CHAMADA);

    expect(d.sintetizar).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ provider: "elevenlabs" }),
    );
  });
});

describe("prepararAudioDoTurno — quando o texto tem DE sair", () => {
  /** Cada recusa tem UM motivo observável: é ele que a tela e o log conseguem ler. */
  async function recusa(
    d: AudioDoTurnoDeps,
    entrada: Partial<typeof CHAMADA> = {},
    linha: Partial<typeof LINHA> | null = LINHA,
  ) {
    const { db } = banco(linha);
    const r = await prepararAudioDoTurno(db, d, { ...CHAMADA, ...entrada });
    expect(r.ok).toBe(false);
    expect(d.sintetizar).not.toHaveBeenCalled();
    return r;
  }

  it("cliente que DIGITOU recebe texto de volta — a reciprocidade do meio", async () => {
    const r = await recusa(deps(), { meioDoCliente: "texto" });
    expect(r).toEqual({ ok: false, motivo: "cliente_digitou" });
  });

  it("sem TTS_API_KEY no .env, degrada para texto sem erro (instalação nova não quebra)", async () => {
    const d = deps({ env: { TTS_API_KEY: "", TTS_BASE_URL: "", TTS_MODEL: "", TTS_VOICE_ID: "" } });
    expect(await recusa(d)).toEqual({ ok: false, motivo: "sem_credencial" });
  });

  it("agente com tts_enabled desligado responde em texto", async () => {
    expect(await recusa(deps(), {}, { ...LINHA, tts_enabled: false })).toEqual({
      ok: false,
      motivo: "desligado",
    });
  });

  it("agente sem linha de preferência (nem instalado) responde em texto", async () => {
    expect(await recusa(deps(), {}, null)).toEqual({ ok: false, motivo: "sem_agente" });
  });

  it("provedor que não existe no produto degrada em vez de chamar URL nenhuma", async () => {
    expect(await recusa(deps(), {}, { ...LINHA, tts_provider: "openai" })).toEqual({
      ok: false,
      motivo: "provedor_desconhecido",
    });
  });

  it("sem voz configurada em lugar nenhum não há o que sintetizar", async () => {
    const { db } = banco({ ...LINHA, tts_voice_id: "" });
    const d = deps({ env: { TTS_API_KEY: "sk_tts", TTS_BASE_URL: "", TTS_MODEL: "", TTS_VOICE_ID: "" } });
    const r = await prepararAudioDoTurno(db, d, CHAMADA);
    expect(r).toEqual({ ok: false, motivo: "sem_voz" });
    expect(d.sintetizar).not.toHaveBeenCalled();
  });

  it("texto vazio ou só de espaço não vira chamada de síntese", async () => {
    expect(await recusa(deps(), { texto: "   \n " })).toEqual({ ok: false, motivo: "texto_vazio" });
  });

  it("texto maior que o teto vira texto: ninguém quer uma nota de voz de 4 minutos", async () => {
    const r = await recusa(deps(), { texto: "a".repeat(TETO_DO_TEXTO_PARA_AUDIO + 1) });
    expect(r).toEqual({ ok: false, motivo: "texto_longo" });
  });

  it("provedor fora do ar degrada para texto — a resposta do cliente não pode depender do TTS", async () => {
    const d = deps({
      sintetizar: vi.fn(async () => {
        throw new Error("sintese_503");
      }),
    });
    const { db } = banco();
    const r = await prepararAudioDoTurno(db, d, CHAMADA);
    expect(r).toEqual({ ok: false, motivo: "sintese_falhou" });
    expect(d.log.warn).toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("áudio que não gravou degrada para texto", async () => {
    const { db } = banco();
    const r = await prepararAudioDoTurno(db, deps({ upload: vi.fn(async () => false) }), CHAMADA);
    expect(r).toEqual({ ok: false, motivo: "guardou_nada" });
  });

  it("o aviso de falha nunca carrega a chave nem o texto do cliente", async () => {
    const { db } = banco();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const d = deps({
      log,
      sintetizar: vi.fn(async () => {
        throw new Error("sintese_402");
      }),
    });
    await prepararAudioDoTurno(db, d, CHAMADA);
    for (const [msg, campos] of log.warn.mock.calls) {
      expect(String(msg)).not.toContain("sk_tts");
      expect(JSON.stringify(campos ?? {})).not.toContain("sk_tts");
      expect(JSON.stringify(campos ?? {})).not.toContain("Passa aqui");
    }
  });
});

describe("corpoDoEnvio — o kind da mídia decide o type que o handler recebe", () => {
  const base = {
    tenantId: ORG,
    leadId: "lead",
    jobId: "job",
    seq: 1,
    conversationId: CONVERSA,
  };

  it("kind audio vira type audio, caminho e mime, e SEM body (a nota de voz não tem legenda)", () => {
    const corpo = corpoDoEnvio(
      { ...base, body: "", media: { kind: "audio", storagePath: "p.mp3", mime: "audio/mpeg" } },
      "k",
    );
    expect(corpo).toEqual({
      conversation_id: CONVERSA,
      type: "audio",
      media_storage_path: "p.mp3",
      media_mime: "audio/mpeg",
      metadata: { idempotency_key: "k" },
    });
  });

  it("mídia SEM kind continua imagem — a foto do catálogo não muda de comportamento", () => {
    const corpo = corpoDoEnvio({ ...base, body: "legenda", media: { storagePath: "p.jpg", mime: "image/jpeg" } }, "k");
    expect(corpo).toMatchObject({ type: "image", body: "legenda" });
  });
});

/**
 * O CAMINHO INTEIRO, do texto ao endpoint do canal, com o provedor e o
 * `guardar` de verdade e só o Storage e o WAHA dubados.
 *
 * É este teste que fecha a DONE WHEN no que é provável aqui: sem WAHA vivo não
 * existe prova de entrega, mas existe — e é medida — prova de que o arquivo
 * nasce na pasta da conversa, sai como `type: "audio"` e chega ao `sendVoice`
 * com `convert: true`, que é quem embrulha no OGG/OPUS que o WhatsApp exige.
 */
describe("texto → áudio na pasta da conversa → sendVoice", () => {
  it("gera o arquivo, grava em whatsapp-media/<org>/<conversa>/ e sai pelo endpoint de voz", async () => {
    const { db } = banco();
    const enviados: Array<{ destino: string; bytes: Uint8Array; mime: string }> = [];
    // Só a REDE é dubada. O provedor, o `guardar` e a allowlist de egress são os
    // de verdade — se o host saísse da allowlist, o teste reprovaria aqui.
    const rede = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ audio: "QUJD" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await prepararAudioDoTurno(
      db,
      {
        env: { TTS_API_KEY: "sk_tts", TTS_BASE_URL: "", TTS_MODEL: "", TTS_VOICE_ID: "" },
        sintetizar: (texto, deps) => sintetizarFala(texto, { ...deps, fetchImpl: rede }),
        upload: async (destino, bytes, mime) => {
          enviados.push({ destino, bytes, mime });
          return true;
        },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      CHAMADA,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 0. A chamada saiu para o host allowlistado, e não para outro.
    expect(String(rede.mock.calls[0]?.[0])).toBe("https://api.fish.audio/v1/tts");

    // 1. O arquivo nasce dentro da conversa, e só dela.
    expect(enviados[0]?.destino).toMatch(new RegExp(`^${ORG}/${CONVERSA}/tts-[0-9a-f]{16}\\.mp3$`));
    expect(enviados[0]?.bytes.length).toBeGreaterThan(0);
    expect(enviados[0]?.mime).toBe("audio/mpeg");

    // 2. O corpo que o handler de mensagens recebe.
    const corpo = corpoDoEnvio(
      { tenantId: ORG, leadId: null, jobId: "job", seq: 1, conversationId: CONVERSA, body: "", media: r.media },
      "k",
    );
    expect(corpo.type).toBe("audio");
    expect(corpo.media_storage_path).toBe(enviados[0]?.destino);

    // 3. O endpoint do canal. `convert: true` é o WAHA embrulhando em OGG/OPUS.
    const plano = wahaSendPlanFor(corpo.type as string, {
      url: "https://storage-assinada/ok",
      mime: corpo.media_mime ?? "application/octet-stream",
    });
    expect(plano.endpoint).toBe("sendVoice");
    expect(plano.payload.convert).toBe(true);
  });
});
