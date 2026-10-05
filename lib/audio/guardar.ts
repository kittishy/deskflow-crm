/**
 * A fala vira ARQUIVO DA CONVERSA, e é só isso que este módulo faz.
 *
 * É o mesmo caminho, e a mesma razão, da foto do catálogo
 * (`agent/fotos-do-produto.ts`): o áudio do TTS é derivado da CONVERSA — do que
 * o cliente perguntou e do que a resposta disse —, então ele mora em
 * `whatsapp-media/<org>/<conversa>/`. Ali a conversa o possui: a inbox mostra,
 * a LGPD apaga junto com a conversa, e nada de fora guarda cópia do áudio de um
 * cliente. O que o canal recebe é o caminho; a URL curta é assinada pelo
 * handler de mensagens, como em toda mídia — nunca base64 na linha do banco.
 *
 * O destino é DETERMINÍSTICO no texto (`tts-<assinatura>.<ext>`): reenviar a
 * mesma resposta depois de um replay de job reaproveita o arquivo em vez de
 * encher a cota de Storage do cliente com cópias de áudio idênticas. A
 * assinatura cobre o TEXTO, não os bytes — a síntese não é determinística byte a
 * byte, e usar os bytes faria cada replay criar um arquivo novo.
 */
import { createHash } from 'node:crypto';

import { createAdminClient } from '@/lib/supabase/admin';

import type { AudioSintetizado, Log } from './types';

export const BUCKET_DA_CONVERSA = 'whatsapp-media';

/** Tamanho da assinatura do texto. Colide só dentro da mesma conversa — que é o alcance. */
const ASSINATURA = 16;

/** `true` = o arquivo está no destino. */
export type GravarAudio = (
  destino: string,
  bytes: Uint8Array,
  mime: string,
) => Promise<boolean>;

export interface FalaPronta {
  /** caminho em `whatsapp-media`, dentro da pasta da conversa */
  storagePath: string;
  mime: string;
}

/**
 * Onde o áudio vai ficar. Determinístico no texto: mesma frase → mesmo arquivo.
 *
 * A extensão vem do que o PROVEDOR devolveu (`audio.extensao`), nunca de uma
 * constante: um provedor que volte opus tem que ser gravado como `.opus`, ou o
 * probe do ffmpeg no `convert` do adapter do canal cai no lugar errado.
 */
export function caminhoDaFala(input: {
  tenantId: string;
  conversationId: string;
  texto: string;
  extensao: string;
}): string {
  const assinatura = createHash('sha256')
    .update(`${input.tenantId}/${input.conversationId}/${input.texto}`, 'utf8')
    .digest('hex')
    .slice(0, ASSINATURA);
  return `${input.tenantId}/${input.conversationId}/tts-${assinatura}.${input.extensao}`;
}

/**
 * Sobe os bytes no bucket da conversa por service role.
 *
 * `upsert` fica FORA: o arquivo já existente é o resultado desejado (mesmo
 * texto, mesmo destino) e subir por cima enquanto um envio anterior ainda
 * aponta para o caminho mudaria o arquivo sob a nota de voz que já está no
 * ar. Objecto existente é sucesso, como a cópia da foto do catálogo.
 */
export function gravarAudioNoStorage(log: Log): GravarAudio {
  return async (destino, bytes, mime) => {
    const { error } = await createAdminClient()
      .storage.from(BUCKET_DA_CONVERSA)
      .upload(destino, bytes, { contentType: mime, upsert: false });
    if (!error) return true;
    if (/already exists/i.test(error.message) || (error as { statusCode?: string }).statusCode === '409') {
      return true;
    }
    log.warn('áudio da fala não gravado na conversa', { detalhe: error.message.slice(0, 120) });
    return false;
  };
}

/**
 * Grava a fala e devolve o que o canal precisa.
 *
 * Áudio de ZERO BYTE não chega ao Storage: é o sintoma de uma síntese que
 * "deu certo" sem gerar som, e subir um arquivo vazio para a conversa é pior
 * que mandar texto — o cliente receberia uma nota de voz que não toca. Volta
 * `null` e quem chama degrada.
 */
export async function guardarAudioDaFala(
  gravar: GravarAudio,
  input: { tenantId: string; conversationId: string; audio: AudioSintetizado; texto: string },
): Promise<FalaPronta | null> {
  if (input.audio.bytes.length === 0) return null;
  const storagePath = caminhoDaFala({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    texto: input.texto,
    extensao: input.audio.extensao,
  });
  if (!(await gravar(storagePath, input.audio.bytes, input.audio.mime))) return null;
  return { storagePath, mime: input.audio.mime };
}
