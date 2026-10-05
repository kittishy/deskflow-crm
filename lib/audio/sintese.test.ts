import { describe, expect, it, vi } from "vitest";

import { EgressBlockedError } from "@/lib/agent-engine/edge/egress";

import { BASE_DO_ELEVENLABS, BASE_DO_FISH, provedorDeVoz, sintetizarFala } from "./sintese";

const CHAVE = "sk_tts_de_teste";
const VOZ = "referencia-da-instalacao";
const MP3 = "QUJD"; // "ABC" em base64

function resposta(base: {
  status?: number;
  json?: unknown;
  binario?: string;
  contentType?: string;
  location?: string;
}) {
  return new Response(base.binario !== undefined ? base.binario : JSON.stringify(base.json ?? {}), {
    status: base.status ?? 200,
    headers: {
      "content-type": base.contentType ?? "application/json",
      ...(base.location ? { location: base.location } : {}),
    },
  });
}

describe("provedorDeVoz — só nomes que existem viram provedor", () => {
  it("conhece fish e elevenlabs", () => {
    expect(provedorDeVoz("fish")?.nome).toBe("fish");
    expect(provedorDeVoz("elevenlabs")?.nome).toBe("elevenlabs");
  });

  it("nome desconhecido (e valor vazio) é ausente, não uma exceção", () => {
    expect(provedorDeVoz("openai")).toBeNull();
    expect(provedorDeVoz("")).toBeNull();
    expect(provedorDeVoz(undefined)).toBeNull();
  });
});

describe("sintetizarFala — Fish Audio", () => {
  it("POSTa em /v1/tts com a chave no Bearer, o modelo no header e devolve os bytes em base64", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => resposta({ json: { audio: MP3 } }));

    const audio = await sintetizarFala("Boa tarde!", {
      provider: "fish",
      credenciais: { apiKey: CHAVE, model: "s2.1-pro-free", voiceId: VOZ },
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_DO_FISH}/v1/tts`);
    expect(init.method).toBe("POST");
    // A chave NUNCA vai na URL: só no header (regra do repo).
    expect(url).not.toContain(CHAVE);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${CHAVE}`);
    expect(headers.model).toBe("s2.1-pro-free");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Boa tarde!",
      reference_id: VOZ,
      format: "mp3",
    });
    expect(Array.from(audio.bytes)).toEqual([0x41, 0x42, 0x43]);
    expect(audio).toMatchObject({ mime: "audio/mpeg", extensao: "mp3" });
  });

  it("base configurada no .env vence a base padrão", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => resposta({ json: { audio: MP3 } }));

    await sintetizarFala("oi", {
      provider: "fish",
      credenciais: { apiKey: CHAVE, voiceId: VOZ, baseUrl: "https://tts.minhaempresa.com" },
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://tts.minhaempresa.com/v1/tts");
  });

  it("barra final a mais no .env não vira barra no caminho", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => resposta({ json: { audio: MP3 } }));

    await sintetizarFala("oi", {
      provider: "fish",
      credenciais: { apiKey: CHAVE, voiceId: VOZ, baseUrl: "https://tts.minhaempresa.com///" },
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://tts.minhaempresa.com/v1/tts");
  });

  it("resposta sem áudio não vira um arquivo de zero byte", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => resposta({ json: {} }));
    await expect(
      synthesizingCom("fish", CHAVE, VOZ, fetchImpl),
    ).rejects.toThrow(/^sintese_sem_audio$/);
  });

  it("status de erro do provedor propaga com o código, sem mensagem do fornecedor", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => resposta({ status: 402, json: { message: "sem crédito" } }));
    await expect(synthesizingCom("fish", CHAVE, VOZ, fetchImpl)).rejects.toThrow(/^sintese_402$/);
  });
});

describe("sintetizarFala — ElevenLabs", () => {
  it("POSTa em /v1/text-to-speech/<voz> com xi-api-key e lê o binário cru (não é base64)", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => resposta({ binario: "PK\x03\x04", contentType: "audio/mpeg" }));

    const audio = await sintetizarFala("Boa tarde!", {
      provider: "elevenlabs",
      credenciais: { apiKey: CHAVE, model: "eleven_flash_v2_5", voiceId: VOZ },
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_DO_ELEVENLABS}/v1/text-to-speech/${encodeURIComponent(VOZ)}?output_format=mp3_44100_128`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe(CHAVE);
    expect(url).not.toContain(CHAVE);
    // `model_id` só quando a instalação escolheu; senão vale o default do
    // ElevenLabs, que é decisão dele e muda com o tempo.
    expect(JSON.parse(String(init.body))).toEqual({ text: "Boa tarde!", model_id: "eleven_flash_v2_5" });
    expect(Array.from(audio.bytes)).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(audio).toMatchObject({ mime: "audio/mpeg", extensao: "mp3" });
  });

  it("sem TTS_MODEL, o corpo não carrega model_id — o provedor aplica o default dele", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => resposta({ binario: "PK", contentType: "audio/mpeg" }));

    await sintetizarFala("oi", {
      provider: "elevenlabs",
      credenciais: { apiKey: CHAVE, voiceId: VOZ },
      fetchImpl,
    });

    expect(JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body))).toEqual({ text: "oi" });
  });

  it("voz com barra não escapa do caminho", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => resposta({ binario: "PK", contentType: "audio/mpeg" }));
    await sintetizarFala("oi", {
      provider: "elevenlabs",
      credenciais: { apiKey: CHAVE, voiceId: "a/b c" },
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${BASE_DO_ELEVENLABS}/v1/text-to-speech/a%2Fb%20c?output_format=mp3_44100_128`,
    );
  });
});

describe("sintetizarFala — contenção de rede (egress fail closed)", () => {
  it("redirect do provedor para fora da allowlist é bloqueado e o corpo NÃO é seguido", async () => {
    const fetchImpl = vi.fn(async () =>
      resposta({ status: 302, json: {}, location: "https://exfil.invalido/vaza" }),
    );

    await expect(synthesizingCom("fish", CHAVE, VOZ, fetchImpl)).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    // Uma chamada só: o 302 foi recusado, não re-emitido contra o host novo.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("base que não é URL falha fechado, sem sair para a rede", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => resposta({ json: { audio: MP3 } }));

    await expect(
      sintetizarFala("oi", {
        provider: "fish",
        credenciais: { apiKey: CHAVE, voiceId: VOZ, baseUrl: "não é um endereço" },
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("o evento de segurança loga SÓ o host — nunca a URL com a chave", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => resposta({ json: { audio: MP3 } }));
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await sintetizarFala("oi", {
      provider: "fish",
      credenciais: { apiKey: CHAVE, voiceId: VOZ, baseUrl: "não é um endereço" },
      fetchImpl,
      log,
    }).catch(() => undefined);

    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { event: "egress_blocked", host: "unparseable" });
    for (const [msg, campos] of log.warn.mock.calls) {
      expect(String(msg)).not.toContain(CHAVE);
      expect(JSON.stringify(campos ?? {})).not.toContain(CHAVE);
    }
  });
});

async function synthesizingCom(
  provider: "fish" | "elevenlabs",
  apiKey: string,
  voiceId: string,
  fetchImpl: typeof fetch,
) {
  return sintetizarFala("Boa tarde!", { provider, credenciais: { apiKey, voiceId }, fetchImpl });
}
