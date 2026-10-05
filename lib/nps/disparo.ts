/**
 * QUANDO PERGUNTAR "COMO FOI?" â€” e, antes disso, quando NÃƒO.
 *
 * ## O que este arquivo Ã©
 *
 * A REGRA do disparo, pura: dado o estado de uma conversa fechada, do canal que
 * a atendeu e do que a organizaÃ§Ã£o marcou, diz se a pesquisa sai agora, se sai
 * por modelo aprovado, ou se nÃ£o sai â€” e **por quÃª**. O texto Ã© o mesmo para
 * toda instalaÃ§Ã£o; quem liga Ã© a organizaÃ§Ã£o, e a resposta Ã© fail-closed.
 *
 * ## Por que a regra mora isolada
 *
 * As decisÃµes caras aqui sÃ£o impossÃ­veis de exercitar contra o banco: uma
 * conversa fechada hÃ¡ duas horas, uma janela de 24 h fechada com o cliente
 * calado, um contato que jÃ¡ recebeu convite ontem. Com a regra dentro da rota,
 * cada uma viraria teste de integraÃ§Ã£o precisando de relÃ³gio, de sessÃ£o de canal
 * e de um nÃºmero banido de mentira. Puras, viram tabelas.
 *
 * ## âš ï¸ A JANELA DE 24 H Ã‰ O LIMITE, E ELE Ã‰ DO CANAL â€” NÃƒO NOSSO
 *
 * `lib/channels/capabilities.ts` Ã© o Ãºnico lugar que sabe o que cada canal
 * permite, e esta arquivo pergunta CAPACIDADE (`exigeModeloForaDaJanela`), nunca
 * o nome do provedor. Nos canais que aceitam texto livre a qualquer hora, a
 * pesquisa sai como texto comum. Nos de hetero-restriÃ§Ã£o (API oficial e o
 * parceiro que a intermedia), texto livre sÃ³ passa enquanto o cliente escreveu
 * nas Ãºltimas 24 h: fora disso, **sÃ³ modelo aprovado** â€” a plataforma recusa com
 * 131047, e mandar o modelo NÃƒO abre a janela (sÃ³ o cliente abre, respondendo).
 *
 * DaÃ­ a consequÃªncia que este arquivo deixa visÃ­vel: **fora da janela e sem
 * modelo aprovado, a pesquisa nÃ£o sai.** NÃ£o hÃ¡ nome de modelo inventado, nÃ£o hÃ¡
 * texto livre "tentando". Quem nÃ£o tem modelo configurado nÃ£o recebe a pergunta,
 * e a linha `nps_responses` nem Ã© criada â€” convite guardado de convite nÃ£o
 * enviado Ã© lixo que depois parece resposta pendente.
 *
 * ## âš ï¸ O COOLDOWN Ã‰ POR CONTATO, E POR QUE 90 DIAS
 *
 * A pergunta Ã© sobre um atendimento. Perguntar sobre o atendimento de marÃ§o
 * para quem foi atendido hoje Ã© ruÃ­do que a pessoa responde por costume â€” e o
 * custo Ã© o nÃºmero dela: quem recebe pergunta demais Ã© quem para. O mesmo
 * cooldown de 90 dias aparece no `growth-manager` (referÃªncia do pedido); aqui
 * ele vem da consulta das respostas recentes do MESMO contato, nÃ£o de uma coluna
 * â€” porque a coluna envelheceria mal e o Ã­ndice por `contact_id` Ã© o que a
 * tornaria gratuita.
 *
 * ## âš ï¸ PERGUNTAR Ã‰ MENSAGEM A UM SER HUMANO â€” e por isso a ordem das recusas
 *
 * A ordem das recusas nÃ£o Ã© estÃ©tica. `nps_desligado` vem PRIMEIRO: com a
 * pesquisa desligada nenhuma outra pergunta Ã© respondida â€” nem "sÃ³ pra saber se
 * teria telefone". `opt_out` vem logo depois: quem mandou STOP nÃ£o volta a
 * receber nada, e o produto que gera o STOP Ã© justamente este (`lib/opt-out/`).
 */
import { windowRemainingMs } from "@/lib/agent-engine/guardrails/messaging-window";

/**
 * Quanto esperar depois de fechar antes de perguntar.
 *
 * 2 h, e nÃ£o 5 minutos: quem acabou de ser atendido ainda pode ter um problema
 * por resolver, e a pergunta "como foi?" nesse instante lÃª como "vÃ¡ embora".
 * E nÃ£o 24 h: depois de um dia a lembranÃ§a jÃ¡ Ã© de outro atendimento.
 */
export const ESPERA_MINIMA_APOS_FECHAR_MS = 2 * 60 * 60 * 1000;

/** Depois disto a resposta nÃ£o Ã© mais sobre aquele atendimento. */
export const PRAZO_MAXIMO_APOS_FECHAR_MS = 7 * 24 * 60 * 60 * 1000;

/** Um convite por contato neste intervalo â€” mesmo em conversa diferente. */
export const COOLDOWN_POR_CONTATO_MS = 90 * 24 * 60 * 60 * 1000;

/** Idioma do modelo quando a organizaÃ§Ã£o nÃ£o diz â€” `sendTemplateForSession` exige. */
export const IDIOMA_PADRAO_DO_MODELO = "pt_BR";

/** O modelo aprovado que a organizaÃ§Ã£o cadastrou para a pesquisa, se houver. */
export interface ModeloDaPesquisa {
  nome: string;
  idioma: string;
}

export interface ConfigDoNps {
  ligado: boolean;
  /** `null` = nenhum modelo cadastrado; fora da janela a pesquisa nÃ£o sai. */
  modelo: ModeloDaPesquisa | null;
}

/**
 * Por que a pesquisa nÃ£o saiu (ou saiu por modelo). Sai no log do cron junto do
 * resto da rodada: "ninguÃ©m foi perguntado" sem motivo Ã© indistinguÃ­vel de "a
 * varredura nÃ£o roda".
 */
export type MotivoDoDisparo =
  | "enviado"
  | "enviado_com_modelo"
  | "nps_desligado"
  | "opt_out"
  | "sem_telefone"
  | "conversa_de_grupo"
  | "fechamento_ausente"
  | "sem_url_publica"
  | "ainda_cedo"
  | "fora_do_prazo"
  | "ja_perguntado"
  | "contato_em_cooldown"
  | "sem_modelo_aprovado";

export interface EntradaDaDecisao {
  /** RelÃ³gio da rodada. Injetado para a regra nÃ£o ler `Date.now()` escondida. */
  agora: Date;
  /** A organizaÃ§Ã£o ligou a pesquisa (`organizations.settings.nps.enabled`). */
  ligado: boolean;
  /** `conversations.service_closed_at` â€” o encerramento canÃ´nico. */
  fechadoEm: string | null;
  /** `conversations.last_inbound_at` â€” a janela de 24 h Ã© contada daqui. */
  ultimoInboundEm: string | null;
  telefone: string | null;
  /** Contato bloqueado ou com opt-out registrado. */
  optOut: boolean;
  isGroup: boolean;
  /** `NEXT_PUBLIC_APP_URL` da instalaÃ§Ã£o. Sem ela nÃ£o hÃ¡ link para convidar. */
  urlPublica: string | null;
  /**
   * CAPACIDADE, nunca o nome do provedor: o canal exige modelo aprovado fora da
   * janela de 24 h? Vem de `capabilitiesOf(...).requiresTemplates`.
   */
  exigeModeloForaDaJanela: boolean;
  /** Nome do modelo aprovado pela organizaÃ§Ã£o, quando existe. */
  modeloAprovado: string | null;
  /** `asked_at` da linha `nps_responses` desta conversa, se jÃ¡ existe. */
  perguntadoEm: string | null;
  /** `asked_at` mais recente do MESMO contato, para o cooldown. */
  ultimoContatoPerguntadoEm: string | null;
}

export interface DecisaoDeDisparo {
  dispara: boolean;
  /** `true` = sai por modelo aprovado; o texto vai no slot, nÃ£o no corpo. */
  viaModelo: boolean;
  motivo: MotivoDoDisparo;
}

function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * `organizations.settings.nps` â€” a configuraÃ§Ã£o da pesquisa, jÃ¡ filtrada.
 *
 * Por que a chave mora aqui e nÃ£o em `lib/organizacao/capacidades.ts`: aquele
 * mÃ³dulo resolve capacidade contra um MÃ“DULO opcional da instalaÃ§Ã£o, e a
 * pesquisa nÃ£o Ã© mÃ³dulo â€” Ã© configuraÃ§Ã£o da empresa, sem chave de instalaÃ§Ã£o, sem
 * tela e sem migraÃ§Ã£o de dado. Fail-closed como o resto do produto: ausente,
 * string, nÃºmero ou erro = desligado. **Nunca lanÃ§a** â€” o cron roda em cima de
 * uma lista de organizaÃ§Ãµes e uma linha malformada nÃ£o pode derrubar a varredura
 * das outras.
 */
export function configDoNps(settings: unknown): ConfigDoNps {
  const cracha = objeto(objeto(settings)?.nps);
  const ligado = cracha?.enabled === true;
  const nome = typeof cracha?.template_name === "string" ? cracha.template_name.trim() : "";
  const idioma =
    typeof cracha?.template_language === "string" ? cracha.template_language.trim() : "";
  return {
    ligado,
    // O idioma tem default (`pt_BR`) porque um modelo sem idioma nÃ£o sai: o
    // `sendTemplateForSession` exige os dois. O NOME nÃ£o tem default â€” inventar
    // um significaria adivinhar um modelo aprovado, que nÃ£o Ã© uma coisa que se
    // adivinha.
    modelo: nome ? { nome, idioma: idioma || IDIOMA_PADRAO_DO_MODELO } : null,
  };
}

/** SÃ³ o booleano liga. Filtro fino sobre `configDoNps`, para quem sÃ³ precisa dele. */
export function npsHabilitado(settings: unknown): boolean {
  return configDoNps(settings).ligado;
}

function instante(valor: string | null | undefined): Date | null {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A decisÃ£o, e sÃ³ ela.
 *
 * A ordem Ã© o contrato (o teste `o desligamento vence o resto` existe por
 * isso): quem nÃ£o ligou nÃ£o Ã© perguntado; quem fez opt-out nÃ£o Ã© perguntado;
 * depois vÃªm as condiÃ§Ãµes de mundo (telefone, grupo, fechamento, URL) e sÃ³ entÃ£o
 * as de tempo (espera, prazo, pergunta anterior, cooldown). Por fim a janela do
 * canal, que decide COMO sai â€” e Ã© a Ãºltima porque, sem modelo aprovado, ela
 * nÃ£o muda nada.
 */
export function decideDisparo(entrada: EntradaDaDecisao): DecisaoDeDisparo {
  const para = (motivo: MotivoDoDisparo): DecisaoDeDisparo => ({
    dispara: false,
    viaModelo: false,
    motivo,
  });

  if (!entrada.ligado) return para("nps_desligado");
  if (entrada.optOut) return para("opt_out");

  if (!entrada.telefone) return para("sem_telefone");
  if (entrada.isGroup) return para("conversa_de_grupo");

  const fechado = instante(entrada.fechadoEm);
  if (!fechado) return para("fechamento_ausente");
  if (!entrada.urlPublica) return para("sem_url_publica");

  const idade = entrada.agora.getTime() - fechado.getTime();
  // Fechamento no futuro (relÃ³gio torto) cai no "cedo", e nÃ£o no "dispara": a
  // comparaÃ§Ã£o crua passaria direto e mandaria a pergunta antes do atendimento.
  if (idade < ESPERA_MINIMA_APOS_FECHAR_MS) return para("ainda_cedo");
  if (idade > PRAZO_MAXIMO_APOS_FECHAR_MS) return para("fora_do_prazo");

  if (instante(entrada.perguntadoEm)) return para("ja_perguntado");

  const ultimoDoContato = instante(entrada.ultimoContatoPerguntadoEm);
  if (
    ultimoDoContato &&
    entrada.agora.getTime() - ultimoDoContato.getTime() < COOLDOWN_POR_CONTATO_MS
  ) {
    return para("contato_em_cooldown");
  }

  const ultimoInbound = instante(entrada.ultimoInboundEm);
  const foraDaJanela =
    entrada.exigeModeloForaDaJanela && windowRemainingMs(entrada.agora, ultimoInbound) <= 0;
  if (foraDaJanela) {
    if (!entrada.modeloAprovado) return para("sem_modelo_aprovado");
    return { dispara: true, viaModelo: true, motivo: "enviado_com_modelo" };
  }

  return { dispara: true, viaModelo: false, motivo: "enviado" };
}

/**
 * O link do convite. A organizaÃ§Ã£o nÃ£o aparece na URL: quem responde Ã© o
 * navegador do cliente, e a rota resolve a org da LINHA persistida, nunca do
 * caminho (mesma regra de `app/api/v1/rastreio/[id]/route.ts`).
 */
export function criarLinkDaPesquisa(urlPublica: string, token: string): string {
  return `${urlPublica.replace(/\/+$/, "")}/api/v1/nps/${token}`;
}

/**
 * O texto da pergunta.
 *
 * TrÃªs decisÃµes na redaÃ§Ã£o, todas custosas:
 *
 *  - **NÃ£o sugere resposta.** "De 0 a 10, o quanto vocÃª recomendaria" mede
 *    educaÃ§Ã£o tanto quanto mede satisfaÃ§Ã£o. O texto diz a escala e o assunto.
 *  - **NÃ£o promete nada que nÃ£o existe.** HÃ¡ uma linha de agradecimento porque
 *    o comentÃ¡rio Ã© lido pela equipe; nÃ£o se anuncia prazo nem quem responde,
 *    porque nada no produto garante isso ainda.
 *  - **No modo modelo, o link Ã© o `{link}`**, que a tela de modelos preenche.
 *    Link colado no corpo de um texto modelado sai errado nos canais que
 *    entregam a versÃ£o aprovada do corpo, e o cliente recebe `{link}` cru.
 */
export function textoDaPesquisa(link: string, opcoes: { viaModelo?: boolean } = {}): string {
  if (opcoes.viaModelo) {
    return "Oi! Como foi o atendimento que acabamos de fazer? Sua nota de 0 a 10 e, se quiser, um comentÃ¡rio: {link}";
  }
  return [
    "Oi! Como foi o atendimento que acabamos de fazer?",
    "DÃª uma nota de 0 a 10 e, se quiser, escreva um comentÃ¡rio:",
    link,
  ].join("\n");
}
