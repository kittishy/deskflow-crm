/**
 * A RESPOSTA EM ÁUDIO — o gancho do turno, com o mesmo desenho do gancho da foto
 * (`agent/fotos-do-produto.ts`): o arquivo fica na pasta da CONVERSA, o teto de
 * `max_sends_per_turn` é respeitado por quem envia, e **degradar para texto é o
 * caminho normal**, nunca a exceção. Um cliente que recebeu áudio quando
 * queria ler — ou quando a instalação não tem chave nenhuma — é pior do que um
 * cliente que recebeu texto.
 *
 * Por que isto é decisão de produto e não detalhe de implementação: responder
 * em áudio para quem escreveu em texto é a forma mais rápida de queimar o
 * contato no WhatsApp. A reciprocidade já é lei do outro lado da casa — em
 * `followup-turn.ts`, "vai só o que o cliente digitou: resposta em mídia não
 * sai". Aqui a mesma regra vale para a NOSSA saída, e no sentido inverso: quem
 * mandou áudio recebe áudio, quem digitou recebe texto. Passar `null` em
 * `meioDoCliente` (chamada sem conversa conhecida) NÃO libera áudio: ausência
 * de informação não é autorização para trocar o meio da resposta.
 *
 * A escada das recusas, na ordem em que a mais barata mata primeiro:
 *   1. `sem_agente`        — não há linha de preferência (instalação nova)
 *   2. `desligado`         — a organização não quer áudio deste agente
 *   3. `sem_credencial`    — a instalação não tem chave de voz
 *   4. `provedor_desconhecido` — a escolha da organização não existe no produto
 *   5. `sem_voz`           — nenhum id de voz em lugar nenhum
 *   6. `cliente_digitou`   — o meio não combina
 * e só depois o texto (vazio/longo) e a rede (`sintese_falhou`, `guardou_nada`).
 * Cada recusa tem UM nome porque a tela e o log precisam dizer qual foi: um "não
 * deu" genérico manda o operador procurar no escuro.
 */
import { guardarAudioDaFala, type GravarAudio } from '@/lib/audio/guardar';
import { provedorConhecido, type sintetizarFala } from '@/lib/audio/sintese';
import type { Log, ProvedorDeVoz } from '@/lib/audio/types';

import type { Queryable } from '../queue/queue';

/**
 * Teto do texto que vira áudio. Medido pelo que o WhatsApp aguenta como nota de
 * voz e pelo que a pessoa aguenta ouvindo: acima disto a resposta vira texto,
 * porque uma nota de voz de quatro minutos no meio de uma conversa de vendas é
 * a forma mais rápida de o cliente parar de responder.
 */
export const TETO_DO_TEXTO_PARA_AUDIO = 3000;

/** Como o cliente falou na última inbound. `null` = não veio de uma mensagem. */
export type MeioDoCliente = 'texto' | 'audio' | null;

export interface PreferenciasDeVoz {
  enabled: boolean;
  provider: string | null;
  voiceId: string | null;
}

/** Por que a resposta NÃO vai em áudio. Um nome por causa — tela e log leem. */
export type MotivoDaRecusa =
  | 'sem_agente'
  | 'desligado'
  | 'sem_credencial'
  | 'provedor_desconhecido'
  | 'sem_voz'
  | 'cliente_digitou'
  | 'texto_vazio'
  | 'texto_longo'
  | 'sintese_falhou'
  | 'guardou_nada';

export type AudioPreparado =
  | {
      ok: true;
      /** Mídia no formato do contrato de canal: `kind` diz que é áudio, não imagem. */
      media: { kind: 'audio'; storagePath: string; mime: string };
    }
  | { ok: false; motivo: MotivoDaRecusa };

/** O que a instalação configurou. As MESMAS chaves de `lib/env.ts` (`TTS_*`). */
export interface VozDaInstalacao {
  TTS_API_KEY: string;
  TTS_BASE_URL: string;
  TTS_MODEL: string;
  TTS_VOICE_ID: string;
}

export interface AudioDoTurnoDeps {
  env: VozDaInstalacao;
  sintetizar: typeof sintetizarFala;
  upload: GravarAudio;
  log: Log;
}

/**
 * A preferência vive na LINHA DO AGENTE (`ai_agents`, migration 0506), e não na
 * versão nem na organização: quem responde é o agente publicado, e trocar de
 * versão não pode trocar a voz no meio de uma conversa.
 *
 * Filtra por `organization_id` mesmo buscando por id: sem isso, um id errado
 * leria a linha de outro agente e o áudio sairia com a voz de outra empresa.
 */
export async function preferenciasDeVozDoAgente(
  db: Queryable,
  input: { tenantId: string; agentId: string | null },
): Promise<PreferenciasDeVoz | null> {
  if (!input.agentId) return null;
  const { rows } = await db.query<{
    tts_enabled: boolean | null;
    tts_provider: string | null;
    tts_voice_id: string | null;
  }>(
    'select tts_enabled, tts_provider, tts_voice_id from ai_agents where organization_id = $1 and id = $2',
    [input.tenantId, input.agentId],
  );
  const linha = rows[0];
  if (!linha) return null;
  return {
    enabled: linha.tts_enabled === true,
    provider: linha.tts_provider ?? null,
    voiceId: linha.tts_voice_id ?? null,
  };
}

function primeiroNaoVazio(...valores: Array<string | null | undefined>): string {
  for (const valor of valores) {
    const limpo = (valor ?? '').trim();
    if (limpo !== '') return limpo;
  }
  return '';
}

/**
 * Deixa o áudio pronto na pasta da conversa, ou diz POR QUE não deu.
 *
 * A preferência da organização manda; o `.env` é só o piso de quem não mexeu na
 * tela. Um provedor que o produto não conhece NÃO cai para o padrão: cair
 * seria a organização pedir uma voz e receber outra, sem ninguém avisar.
 */
export async function prepararAudioDoTurno(
  db: Queryable,
  deps: AudioDoTurnoDeps,
  input: {
    tenantId: string;
    conversationId: string;
    agentId: string | null;
    texto: string;
    meioDoCliente: MeioDoCliente;
  },
): Promise<AudioPreparado> {
  const preferencias = await preferenciasDeVozDoAgente(db, {
    tenantId: input.tenantId,
    agentId: input.agentId,
  });
  if (!preferencias) return { ok: false, motivo: 'sem_agente' };
  if (!preferencias.enabled) return { ok: false, motivo: 'desligado' };
  if (deps.env.TTS_API_KEY.trim() === '') return { ok: false, motivo: 'sem_credencial' };

  const provider = (preferencias.provider ?? '').trim();
  if (!provedorConhecido(provider)) return { ok: false, motivo: 'provedor_desconhecido' };

  const voiceId = primeiroNaoVazio(preferencias.voiceId, deps.env.TTS_VOICE_ID);
  if (voiceId === '') return { ok: false, motivo: 'sem_voz' };

  // Reciprocidade depois da configuração e antes do texto: um cliente que
  // digitou é recusa mesmo com TTS ligado, voz escolhida e frase pronta.
  if (input.meioDoCliente !== 'audio') return { ok: false, motivo: 'cliente_digitou' };

  const texto = input.texto.trim();
  if (texto === '') return { ok: false, motivo: 'texto_vazio' };
  if (texto.length > TETO_DO_TEXTO_PARA_AUDIO) return { ok: false, motivo: 'texto_longo' };

  let audio;
  try {
    audio = await deps.sintetizar(texto, {
      provider: provider as ProvedorDeVoz,
      credenciais: {
        apiKey: deps.env.TTS_API_KEY.trim(),
        voiceId,
        ...(deps.env.TTS_BASE_URL.trim() !== '' ? { baseUrl: deps.env.TTS_BASE_URL.trim() } : {}),
        ...(deps.env.TTS_MODEL.trim() !== '' ? { model: deps.env.TTS_MODEL.trim() } : {}),
      },
      log: deps.log,
    });
  } catch (erro) {
    // Só o NOME do erro entra no log: a mensagem do provedor pode vir com o
    // texto que ele tentou falar, e o log da VPS é lido por gente.
    deps.log.warn('síntese de voz falhou — a resposta segue em texto', {
      motivo: erro instanceof Error ? erro.message.slice(0, 60) : 'desconhecido',
    });
    return { ok: false, motivo: 'sintese_falhou' };
  }

  const fala = await guardarAudioDaFala(deps.upload, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    audio,
    texto,
  });
  if (!fala) return { ok: false, motivo: 'guardou_nada' };
  return { ok: true, media: { kind: 'audio', storagePath: fala.storagePath, mime: fala.mime } };
}
