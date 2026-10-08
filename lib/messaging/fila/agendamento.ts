/**
 * A REGRA do próximo horário — a parte que decide QUANDO uma mensagem sai.
 *
 * ## O que isto é, e o que não é
 *
 * Isto é ritmo de TRABALHO HUMANO: impedir que a mão envie para oito contatos
 * no mesmo minuto porque a pessoa clicou "Enviar" oito vezes seguidas. Cada
 * mensagem continua escrita para UM contato, com o texto que a pessoa escreveu.
 *
 * NÃO é evasão de detecção. Não há aqui nenhum estamos, nenhuma técnica contra
 * o WhatsApp, nenhum jiter para parecer humano. O sorteio dentro da faixa serve
 * para o operador não ver um relógio mecânico na tela, e nada além disso. Os
 * limites e políticas do canal continuam valendo, intocados — ver
 * `lib/agent-engine/pacing/` (pacing_ledger), que é a REGRA de verdade e que
 * este arquivo não toca.
 *
 * ## A fila é uma CORRENTE
 *
 * O modelo é o que evita o defeito mais óbvio de uma fila mal feita: dez
 * mensagens nascendo com o mesmo `scheduled_at` e a tela mostrando dez "09:34".
 *
 * Existe um único instante que comanda tudo — o fim da cadeia:
 *
 *     fimDaCadeia = maior(último envio real para outro contato,
 *                        maior scheduled_at já ocupado na fila)
 *
 * Sem cadeia (nada enviado, fila vazia) a mensagem sai AGORA. Com cadeia, a
 * próxima nasce em `fimDaCadeia + intervalo sorteado na faixa`. Se esse
 * resultado já tiver passado, manda-se agora: a fila ficou para trás, e segurar
 * mais não ajuda ninguém.
 *
 * ## Por que "contato diferente" e não "último envio"
 *
 * Se a régua fosse o último envio sem olhar o contato, responder a alguém que
 * mandou mensagem agora há 10 segundos custaria minutos de silêncio — o oposto
 * de conversa. Por isso o fim da corrente só considera envio para contato
 * DIFERENTE (ver `ultimoEnvioParaOutroContato` em `consultas.ts`). Três
 * mensagens seguidas para a mesma pessoa é conversa, e conversa não espera.
 */

/** Piso da faixa, em segundos, quando nada foi configurado. */
export const INTERVALO_PADRAO_MIN_S = 90;
/** Teto aceitável de configuração. Acima disto já é outra feature (agendamento). */
export const INTERVALO_MAXIMO_TETO_S = 3_600;

export interface EntradaDoAgendamento {
  /** Instante da decisão. Injetado para o teste não depender do relógio. */
  agora: Date;
  /**
   * Fim da cadeia: maior entre o último envio para OUTRO contato e o maior
   * `scheduled_at` já ocupado. `null` = nada enviado e fila vazia → manda-se
   * agora. (Quem monta isso é `ultimoEnvioParaOutroContato`, em `consultas.ts`.)
   */
  fimDaCadeia: Date | null;
  intervaloMinimoS: number;
  intervaloMaximoS: number;
  /**
   * Sorteio dentro da faixa, injetado. `() => 0` dá o mínimo, `() => 0.999…`
   * dá o máximo. Existe para o teste ser determinístico e para a tela não
   * mostrar relógio.
   */
  sorteio?: () => number;
}

function sorteioPadrao(): number {
  return Math.random();
}

/**
 * Normaliza a faixa. Uma faixa invertida (min > max) não pode travar a fila:
 * cai para o mínimo, que é a escolha conservadora — a mensagem sai mais cedo
 * em vez de nunca sair.
 */
export function normalizarIntervalos(minS: number, maxS: number): { minS: number; maxS: number } {
  const brutoMin = Number(minS);
  const brutoMax = Number(maxS);
  const min = Math.max(0, Math.floor(Number.isFinite(brutoMin) ? brutoMin : INTERVALO_PADRAO_MIN_S));
  const max = Math.floor(Number.isFinite(brutoMax) ? brutoMax : min);
  return { minS: min, maxS: Math.max(min, max) };
}

/**
 * Próximo horário de envio.
 *
 * Retorna `agora` quando não há cadeia, ou quando o intervalo mínimo já passou
 * — nesse caso mandar é correto e atrasar seria burocracia. Caso contrário
 * devolve `fimDaCadeia + (min + sorteio na faixa restante)`, sempre estritamente
 * depois do fim da cadeia, o que impede horário repetido por construção.
 */
export function proximoSlotDeEnvio(entrada: EntradaDoAgendamento): Date {
  const { minS, maxS } = normalizarIntervalos(entrada.intervaloMinimoS, entrada.intervaloMaximoS);
  const { agora, fimDaCadeia } = entrada;

  // Sem cadeia: nada foi enviado e não há fila. Envio imediato.
  if (!fimDaCadeia) return agora;

  // O mínimo já passou e a fila está vazia ou atrás: manda agora.
  const maisCedo = fimDaCadeia.getTime() + minS * 1000;
  if (maisCedo <= agora.getTime()) return agora;

  const sorteio = entrada.sorteio ?? sorteioPadrao;
  const amplitude = maxS - minS;
  const sorteado = amplitude === 0 ? 0 : Math.min(amplitude, Math.max(0, sorteio() * amplitude));
  // `minS` entra UMA vez, medido a partir do fim da cadeia. Aplicá-lo duas vezes
  // (piso + soma) dava gaps de 180–270s com a faixa 90–180 — o bug que o teste
  // "sorteia DENTRO da faixa" existe para segurar.
  const atrasoS = minS + sorteado;
  return new Date(fimDaCadeia.getTime() + Math.round(atrasoS * 1000));
}

/**
 * Momento a partir do qual o PRÓXIMO envio para outro contato está liberado.
 * Mesmo raciocínio sem o sorteio: serve para a decisão "posso mandar agora?".
 *
 * O resultado nunca é anterior a `agora`: um minuto já cumprido libera, e
 * devolver um instante passado faria o chamador esperar para sempre.
 */
export function proximoLiberadoParaOutroContato(
  agora: Date,
  fimDaCadeia: Date | null,
  intervaloMinimoS: number,
): Date {
  if (!fimDaCadeia) return agora;
  const { minS } = normalizarIntervalos(intervaloMinimoS, intervaloMinimoS);
  return new Date(Math.max(agora.getTime(), fimDaCadeia.getTime() + minS * 1000));
}

/** A cadeia está pronta para receber? Verdadeiro = pode mandar sem esperar. */
export function podeEnviarAgora(agora: Date, fimDaCadeia: Date | null, intervaloMinimoS: number): boolean {
  return proximoLiberadoParaOutroContato(agora, fimDaCadeia, intervaloMinimoS).getTime() <= agora.getTime();
}