/**
 * Fish Audio — o provedor de voz do produto.
 *
 * Contrato medido na doc oficial em 2026-10-02
 * (`https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech`),
 * não de memória:
 *
 *   POST https://api.fish.audio/v1/tts
 *   Authorization: Bearer <token>
 *   Content-Type: application/json
 *   model: s1 | s2-pro | s2.1-pro | s2.1-pro-free | drama-3-preview   (header)
 *   body: { text, reference_id, format, ... }
 *   → 200 { "audio": "<base64>", ... }
 *
 * `format` aceita `wav | pcm | mp3 | opus` — NÃO aceita `ogg`. Pedimos `mp3`,
 * que é o default documentado deles e o formato de maior certeza de probe
 * para o `convert: true` do WAHA.
 *
 * `reference_id` é o id do modelo de voz (a doc: "Single speaker: voice model
 * ID string"). Sem ele — e sem `references` — a chamada não tem voz; quem
 * recusa antes é o hook do turno (`sem_voz`), não esta camada.
 */
import { ErroDeSintese, type AudioSintetizado, type ProvedorDeSintese } from '../types';

export const BASE_DO_FISH = 'https://api.fish.audio';

/** Formato pedido ao Fish. Ver a nota do arquivo sobre `ogg` não existir aqui. */
const FORMATO = 'mp3';

/**
 * Base64 → bytes, em Node sem depender de `atob` (que não existe lá) e sem
 * `Buffer`, para o módulo não acoplar em runtime.
 */
function base64ParaBytes(b64: string): Uint8Array {
  const limpo = b64.trim();
  if (limpo === '') throw new ErroDeSintese('sintese_sem_audio');
  const binario = Buffer.from(limpo, 'base64');
  if (binario.length === 0) throw new ErroDeSintese('sintese_sem_audio');
  return new Uint8Array(binario);
}

export function provedorFish(): ProvedorDeSintese {
  return {
    nome: 'fish',
    basePadrao: BASE_DO_FISH,
    async sintetizar(texto, credenciais, deps): Promise<AudioSintetizado> {
      const url = `${deps.base}/v1/tts`;
      // O header `model` só vai quando a instalação escolheu um: vazio OU
      // desconhecido faz o endpoint cair em `s2.1-pro` do lado deles (a doc),
      // e essa é a escolha DELE, não um default que a gente inventa aqui.
      const modelo = (credenciais.model ?? '').trim();
      const res = await deps.buscar(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credenciais.apiKey}`,
          'Content-Type': 'application/json',
          ...(modelo === '' ? {} : { model: modelo }),
        },
        body: JSON.stringify({
          text: texto,
          // Vazio aqui é erro do chamador (o hook recusa antes); mandamos assim
          // mesmo porque o corpo é o contrato do endpoint, não o nosso.
          reference_id: credenciais.voiceId ?? '',
          format: FORMATO,
        }),
      });
      if (!res.ok) throw new ErroDeSintese(`sintese_${res.status}`);
      const json = (await res.json()) as { audio?: unknown };
      if (typeof json.audio !== 'string') throw new ErroDeSintese('sintese_sem_audio');
      return { bytes: base64ParaBytes(json.audio), mime: 'audio/mpeg', extensao: FORMATO };
    },
  };
}
