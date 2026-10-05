/**
 * O NPS DA ORGANIZAÃ‡ÃƒO â€” a conta, e o porquÃª de ela recusar certainos nÃºmeros.
 *
 * ## O que este arquivo Ã©
 *
 * A matemÃ¡tica do Net Promoter Score, pura e testada (`./agregado.test.ts`).
 * O espelho no banco Ã© `public.fn_nps_respostas(p_org)` (migration 0507), que
 * roda a MESMA conta no servidor para a tela nÃ£o trazer dez mil respostas para
 * o navegador somar. Regra em prosa escrita duas vezes diverge; por isso o
 * vocabulÃ¡rio (faixas, amostra mÃ­nima, arredondamento) Ã© este arquivo e a
 * funÃ§Ã£o SQL sÃ³ o traduz.
 *
 * ## A FAIXA Ã‰ CLÃSSICA E NÃƒO Ã‰ NEGOCIÃVEL
 *
 *   9-10 â†’ promotor Â· 7-8 â†’ neutro Â· 0-6 â†’ detrator
 *
 * NPS Ã© `(promotores - detratores) / respondidas Ã— 100`. O neutro nÃ£o entra no
 * numerador e CONTA no total: Ã© o que faz o nÃºmero cair sem que ninguÃ©m esteja
 * descontente â€” e Ã© a diferenÃ§a entre "cliente indiferente" e "cliente ganho".
 *
 * ## POR QUE HÃ AMOSTRA MÃNIMA
 *
 * `-100` de uma resposta sÃ³ nÃ£o Ã© medida, Ã© artefato. Um painel que mostra
 * "-100" com uma resposta leva a equipe a desligar um canal inteiro por causa
 * de um cliente que respondeu mal. O mesmo piso de 5 decisÃµes jÃ¡ decide a taxa
 * de aceite em `app/api/v1/cron/proposal-acceptance-rate/route.ts`; aqui ele
 * devolve `null` em vez de `0`, porque `0` Ã© um NPS possÃ­vel e verdadeiro.
 *
 * ## A LINHA CORROMPIDA Ã‰ CONTA, NÃƒO Ã‰ SILÃŠNCIO
 *
 * `descartadas` existe para o agregado nÃ£o esconder pontuaÃ§Ã£o fora da faixa:
 * o CHECK do banco (0..10) deveria impedi-la, e Ã© justamente por isso que uma
 * vez que ela aparece Ã© sinal de defeito. Engolir faria o nÃºmero sair plausÃ­vel
 * e errado â€” o pior tipo de defeito deste repositÃ³rio.
 */
/** A faixa do NPS. `neutro` Ã© o nome do produto, nÃ£o "passivo". */
export type FaixaDeNps = "promotor" | "neutro" | "detrator";

/**
 * Abaixo disto o NPS Ã© `null`. Cinco Ã© o mesmo piso da taxa de aceite: Ã© o
 * menor nÃºmero em que a proporÃ§Ã£o jÃ¡ diz alguma coisa sobre a operaÃ§Ã£o.
 */
export const MINIMO_DE_RESPOSTAS = 5;

/** Uma linha de `nps_responses`, do jeito que a tela e a funÃ§Ã£o SQL a enxergam. */
export interface RespostaDeNps {
  /** `null` enquanto ninguÃ©m respondeu â€” a pergunta foi feita, a nota nÃ£o. */
  score: number | null;
  answered_at?: string | null;
}

export interface NpsAgregado {
  /** Linhas com convite enviado (`asked_at`), respondidas ou nÃ£o. */
  perguntadas: number;
  /** Linhas com nota. */
  respondidas: number;
  promotores: number;
  neutros: number;
  detratores: number;
  /** Notas fora de 0..10 ou fracionÃ¡rias â€” sinal de defeito, nÃ£o de cliente. */
  descartadas: number;
  /** `null` abaixo de `MINIMO_DE_RESPOSTAS`. Inteiro, como a rÃ©gua Ã© lida. */
  nps: number | null;
  /** `respondidas / perguntadas` em %, 0 quando ninguÃ©m foi perguntado. */
  taxa_de_resposta: number;
}

/** Inteiro de 0 a 10 na faixa correta; `null` fora dela (inclusive fracionÃ¡rio). */
export function classifica(score: number): FaixaDeNps | null {
  if (!Number.isInteger(score) || score < 0 || score > 10) return null;
  if (score >= 9) return "promotor";
  if (score >= 7) return "neutro";
  return "detrator";
}

/**
 * O nÃºmero da casa, a partir das linhas.
 *
 * Aceita tanto as linhas respondidas (`score` preenchido) quanto as perguntadas
 * e nÃ£o respondidas (`score: null`) â€” a diferenÃ§a entre `perguntadas` e
 * `respondidas` Ã© a taxa de resposta, e Ã© ela que diz se a pergunta estÃ¡
 * adianta ou se ninguÃ©m liga para ela.
 */
export function agregaNps(respostas: readonly RespostaDeNps[]): NpsAgregado {
  let promotores = 0;
  let neutros = 0;
  let detratores = 0;
  let respondidas = 0;
  let descartadas = 0;

  for (const linha of respostas) {
    if (linha.score === null) continue;
    const faixa = classifica(linha.score);
    if (faixa === null) {
      descartadas++;
      continue;
    }
    respondidas++;
    if (faixa === "promotor") promotores++;
    else if (faixa === "neutro") neutros++;
    else detratores++;
  }

  const perguntadas = respostas.length;
  return {
    perguntadas,
    respondidas,
    promotores,
    neutros,
    detratores,
    descartadas,
    nps:
      respondidas < MINIMO_DE_RESPOSTAS
        ? null
        : Math.round(((promotores - detratores) / respondidas) * 100),
    taxa_de_resposta: perguntadas === 0 ? 0 : Math.round((respondidas / perguntadas) * 10000) / 100,
  };
}
