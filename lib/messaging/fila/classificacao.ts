/**
 * QUE TIPO DE ENVIO É ESTE — e, portanto, QUANTO ATRASADA PODE FICAR.
 *
 * ## A regra, em uma frase
 *
 * A prioridade responde a uma pergunta só: **essa mensagem é alguém que está
 * esperando resposta agora?** Se alguém está com a bola na mão, nada pode
 * passar na frente. Se é uma abordagem para quem ainda não falou comigo, ela
 * espera — e espera de boa, porque é a única coisa na fila que pode esperar.
 *
 * ## Por que inferir do CRM em vez de perguntar à tela
 *
 * A pessoa não deveria ter que classificar cada mensagem. O CRM já sabe:
 * `conversations.last_inbound_at` diz que o contato falou por último,
 * `last_outbound_at` diz que nós respondemos depois, `awaiting_since` (regra
 * da issue #990) diz há quanto tempo ele está esperando. Um follow-up é uma
 * intenção já gravada. Então a inferência é o caminho normal, e um campo
 * explícito existe só para o operator corrigir a inferência quando quiser.
 *
 * Isto NÃO toca na IA: `priorizar_conversas_ativas` decide a ordem da fila
 * humana. Os envios do agente têm o próprio ritmo (`pacing_ledger`) e não
 * passam por aqui.
 */

/** Os quatro tipos que a tela mostra e que a prioridade ordena. */
export const TIPOS_DE_ENVIO = ["resposta", "conversa_ativa", "follow_up", "prospeccao"] as const;
export type TipoDeEnvio = (typeof TIPOS_DE_ENVIO)[number];

/**
 * Menor número = sai primeiro. A ordem é a do pedido: quem está escrevendo
 * agora, depois quem já estava em conversa, depois o combinado, e por último
 * o frio.
 *
 * O peso entre conversa ativa e follow-up é 10, não 1, porque um follow-up
 * é uma promessa de horário combinado com o cliente; conversa ativa é o
 * atendimento em curso agora. Dez posições basta para que uma conversa de
 * hoje sempre antecipe um follow-up de amanhã, e o saldo entre as duas não
 * depende de mais nada.
 */
export const PRIORIDADE: Record<TipoDeEnvio, number> = {
  resposta: 0,
  conversa_ativa: 10,
  follow_up: 20,
  prospeccao: 30,
};

/** Ordem canônica, para a tela e para o badge de contagem. */
export const ORDEM_DE_PRIORIDADE: readonly TipoDeEnvio[] = [
  "resposta",
  "conversa_ativa",
  "follow_up",
  "prospeccao",
];

/** Rótulo curto para a interface — a fila precisa explicar a si mesma. */
export const ROTULO_DO_TIPO: Record<TipoDeEnvio, string> = {
  resposta: "Resposta",
  conversa_ativa: "Conversa ativa",
  follow_up: "Follow-up",
  prospeccao: "Nova abordagem",
};

/** Só a prospecção conta para o limite diário (ver `limite-diario.ts`). */
export function consomeLimiteDiario(tipo: TipoDeEnvio): boolean {
  return tipo === "prospeccao";
}

/**
 * O que o CRM sabe sobre a conversa, no instante da decisão.
 *
 * Todos os campos são null-safe de propósito: conversa sem nenhum histórico
 * (primeiro contato de uma prospecção) é um caso normal, não um erro, e a
 * inferência tem de cair em `prospeccao` em vez de estourar.
 */
export interface RetratoDaConversa {
  contactId: string;
  /** A pessoa falou por último? `conversations.last_inbound_at`. */
  lastInboundAt: string | null;
  /** Nós respondemos depois disso? `conversations.last_outbound_at`. */
  lastOutboundAt: string | null;
  /** Há quanto tempo ele espera, sem resposta nossa. migration 0267. */
  awaitingSince: string | null;
  /** O contato tem follow-up vivo? `followup_enrollments` / next follow-up. */
  temFollowUpMarcado: boolean;
  /** O contato veio de uma lista/prospecção, e não de uma conversa? */
  veioDeProspeccao?: boolean;
}

/**
 * Janela em que uma conversa conta como "ativa". Passado isso, ela volta a ser
 * follow-up ou prospecção conforme os outros sinais — uma conversa de três dias
 * não é atendimento em curso, é histórico.
 */
export const JANELA_DE_CONVERSA_ATIVA_MS = 24 * 60 * 60 * 1000;

function comoData(valor: string | null): Date | null {
  if (!valor) return null;
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

/**
 * Infere o tipo. A ordem dos testes NÃO é decorativa: cada `if` é o caso mais
 * específico, e inverter dois muda o comportamento em produção sem quebrar
 * teste nenhum.
 *
 * 1. `resposta` — o contato falou e nós não respondemos. A bola está com ele.
 * 2. `conversa_ativa` — houve troca nas últimas 24h e nós respondemos (ou ao
 *    menos a conversa não está parada).
 * 3. `follow_up` — follow-up marcado, sem sinal de bola na mão.
 * 4. `prospeccao` — resto, incluindo conversa vazia.
 */
export function classificarEnvio(retrato: RetratoDaConversa, agora: Date): TipoDeEnvio {
  const inbound = comoData(retrato.lastInboundAt);
  const outbound = comoData(retrato.lastOutboundAt);
  const dentroDaJanela = (d: Date) => agora.getTime() - d.getTime() <= JANELA_DE_CONVERSA_ATIVA_MS;

  // 1. Bola na mão do contato: falou depois da nossa última resposta — E está
  //    dentro da janela.
  //
  //    A janela não é enfeite. Sem ela, um inbound de TRÊS DIAS que ninguém
  //    respondeu entra como `resposta` (prioridade 0) para sempre: a fila inteira
  //    ficaria atrás de uma conversa velha, e o que o dono pediu — "prospecção
  //    não atrasa quem está falando agora" — viraria o contrário. Um follow-up
  //    marcado sobre uma conversa parada cai no passo 3, que é o que ele é.
  const semResposta = inbound !== null && (outbound === null || inbound.getTime() > outbound.getTime());
  if (semResposta && dentroDaJanela(inbound)) {
    return "resposta";
  }

  // 2. Conversa viva: alguma mensagem dentro da janela.
  const maisRecente = inbound && outbound ? (inbound > outbound ? inbound : outbound) : (inbound ?? outbound);
  if (maisRecente && dentroDaJanela(maisRecente)) {
    return "conversa_ativa";
  }

  // 3. Combinado marcado.
  if (retrato.temFollowUpMarcado) return "follow_up";

  // 4. Frio. `veioDeProspeccao` é só um reforço: uma lista que o operador
  //    montou é prospecção mesmo que o CRM já tenha anotado alguma troca.
  return "prospeccao";
}

/**
 * O override da tela. Uma inferência errada custa um clique para corrigir, não
 * um estrago: o operador escolhe o tipo certo e a fila obedece.
 */
export function comTipoEscolhido(retrato: RetratoDaConversa, escolhido: TipoDeEnvio, agora: Date): TipoDeEnvio {
  const inferido = classificarEnvio(retrato, agora);
  // Escolher explicitamente NÃO pode rebaixar uma resposta: se o contato está
  // com a bola na mão, ele sai antes de qualquer follow-up. Ver a nota de
  // segurança em `classificarEnvio`.
  if (inferido === "resposta") return "resposta";
  void agora;
  return escolhido;
}