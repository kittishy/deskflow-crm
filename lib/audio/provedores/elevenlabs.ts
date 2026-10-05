/**
 * ElevenLabs — o segundo provedor de voz, para a organização que já tem chave
 * dele.
 *
 * Contrato medido na doc oficial em 2026-10-02
 * (`https://elevenlabs.io/docs/api-reference/text-to-speech/convert` e o
 * catálogo de `output_format`), não de memória:
 *
 *   POST https://api.elevenlabs.io/v1/text-to-speech/<voice_id>?output_format=<fmt>
 *   xi-api-key: <key>
 *   body: { text, model_id? }
 *   → 200 <binário do áudio, NÃO base64>
 *
 * Duas diferenças do Fish que mudam o código: a chave vai no header `xi-api-key`
 * (não `Authorization`), e a voz é PARÂMETRO DE CAMINHO (não campo do corpo) —
 * por isso o `encodeURIComponent`, que também impede uma voz com `/` de
 * reescrever a rota.
 *
 * `output_format` segue `{codec}_{sampleRate}_{bitrate}`. Pedimos
 * `mp3_44100_128`, o default documentado deles.
 */
import { ErroDeSintese, type AudioSintetizado, type ProvedorDeSintese } from '../types';

export const BASE_DO_ELEVENLABS = 'https://api.elevenlabs.io';

const FORMATO = 'mp3_44100_128';

export function provedorElevenLabs(): ProvedorDeSintese {
  return {
    nome: 'elevenlabs',
    basePadrao: BASE_DO_ELEVENLABS,
    async sintetizar(texto, credenciais, deps): Promise<AudioSintetizado> {
      const url = `${deps.base}/v1/text-to-speech/${encodeURIComponent(credenciais.voiceId ?? '')}?output_format=${FORMATO}`;
      const modelo = (credenciais.model ?? '').trim();
      const res = await deps.buscar(url, {
        method: 'POST',
        headers: {
          'xi-api-key': credenciais.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        // Sem `model_id` quando a instalação não escolheu: vale o default do
        // provedor, que é decisão dele e muda com o tempo.
        body: JSON.stringify(modelo === '' ? { text: texto } : { text: texto, model_id: modelo }),
      });
      if (!res.ok) throw new ErroDeSintese(`sintese_${res.status}`);
      // Aqui a resposta é o ÁUDIO CRU — `arrayBuffer`, nunca `json`. Um
      // documento de erro com status 200 não existe na API deles; corpo vazio
      // com 200 é o sintoma de cota, e arquivo de zero byte não vai a lugar
      // nenhum.
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) throw new ErroDeSintese('sintese_sem_audio');
      return { bytes, mime: 'audio/mpeg', extensao: 'mp3' };
    },
  };
}
