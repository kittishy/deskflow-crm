import { describe, expect, it, vi } from "vitest";

import { caminhoDaFala, guardarAudioDaFala } from "./guardar";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CONVERSA = "cccccccc-0000-4000-8000-000000000001";
const OUTRA_ORG = "aaaaaaaa-0000-4000-8000-000000000002";

const FALA = { bytes: new Uint8Array([1, 2, 3]), mime: "audio/mpeg", extensao: "mp3" };

/**
 * Substitui o Storage: o destino, os bytes e o tipo são o que o cliente
 * recebe; a pasta é o que a conversa possui (a LGPD apaga junto com ela).
 */
function gravador(resultado: boolean = true) {
  const chamadas: Array<{ destino: string; bytes: Uint8Array; mime: string }> = [];
  const upload = vi.fn(async (destino: string, bytes: Uint8Array, mime: string) => {
    chamadas.push({ destino, bytes, mime });
    return resultado;
  });
  return { upload, chamadas };
}

describe("caminhoDaFala — o áudio vive na pasta da CONVERSA", () => {
  const entrada = { tenantId: ORG, conversationId: CONVERSA, texto: "Boa tarde!", extensao: "mp3" };

  it("é whatsapp-media/<org>/<conversa>/tts-<assinatura>.<ext>", () => {
    expect(caminhoDaFala(entrada)).toMatch(new RegExp(`^${ORG}/${CONVERSA}/tts-[0-9a-f]{16}\\.mp3$`));
  });

  it("é determinístico no TEXTO: reenviar a mesma frase reaproveita o arquivo (não enche a cota)", () => {
    expect(caminhoDaFala(entrada)).toBe(caminhoDaFala(entrada));
  });

  it("texto diferente muda o caminho — duas falas não se sobrescrevem", () => {
    expect(caminhoDaFala(entrada)).not.toBe(caminhoDaFala({ ...entrada, texto: "outra coisa" }));
  });

  it("conversa diferente muda o caminho — a fala não vaza para outra conversa", () => {
    expect(caminhoDaFala(entrada)).not.toBe(
      caminhoDaFala({ ...entrada, conversationId: "cccccccc-0000-4000-8000-000000000002" }),
    );
  });

  it("nunca sai da conversa que pediu", () => {
    const c = caminhoDaFala(entrada);
    expect(c.startsWith(`${ORG}/${CONVERSA}/`)).toBe(true);
    expect(c).not.toContain(OUTRA_ORG);
  });
});

describe("guardarAudioDaFala — o que o Storage devolve é o que o canal assina", () => {
  it("grava os bytes no destino e devolve caminho + mime", async () => {
    const { upload, chamadas } = gravador();

    const r = await guardarAudioDaFala(upload, {
      tenantId: ORG,
      conversationId: CONVERSA,
      audio: FALA,
      texto: "Boa tarde!",
    });

    expect(chamadas).toEqual([{ destino: r?.storagePath, bytes: FALA.bytes, mime: "audio/mpeg" }]);
    expect(r).toEqual({ storagePath: r?.storagePath, mime: "audio/mpeg" });
  });

  it("fala que não gravou volta como null — quem chama degrada para texto", async () => {
    const { upload } = gravador(false);

    const r = await guardarAudioDaFala(upload, {
      tenantId: ORG,
      conversationId: CONVERSA,
      audio: FALA,
      texto: "oi",
    });

    expect(r).toBeNull();
  });

  it("áudio de zero byte não chega ao Storage", async () => {
    const { upload } = gravador();

    const r = await guardarAudioDaFala(upload, {
      tenantId: ORG,
      conversationId: CONVERSA,
      audio: { bytes: new Uint8Array(0), mime: "audio/mpeg", extensao: "mp3" },
      texto: "oi",
    });

    expect(upload).not.toHaveBeenCalled();
    expect(r).toBeNull();
  });
});
