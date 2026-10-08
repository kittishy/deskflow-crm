/**
 * O TETO DIÁRIO DE NOVAS ABORDAGENS — e por que ele não conta resposta.
 *
 * A tela pede "Limite diário de novas abordagens". A palavra que faz o trabalho
 * é **abordagens**: o que o teto protege é a reputação do número e a paciência
 * de quem ainda não deu o aceite. Uma resposta para alguém que mandou mensagem
 * NÃO é abordagem — é atendimento, e atendimento que espera vira um Lead que
 * some em silêncio. Por isso o limite nunca pode travar uma resposta, mesmo
 * com o teto atingido: aqui só entra `prospeccao`.
 */
import { consomeLimiteDiario, type TipoDeEnvio } from "./classificacao";

export interface EntradaDoLimite {
  tipo: TipoDeEnvio;
  /** Teto configurado. `0` desliga o limite. */
  limite: number;
  /** Quantas abordagens JÁ foram hoje: na fila (pendente/processando) e enviadas. */
  abordagensHoje: number;
}

export interface VereditoDoLimite {
  permite: boolean;
  /** `undefined` quando não bloqueou. Serve para a tela explicar o bloqueio. */
  motivo?: "limite_diario_de_abordagens";
  /** Quanto ainda resta hoje. `null` quando não há teto. */
  restantes: number | null;
}

/**
 * Um item só consome o teto se ele é abordagem E está vivo ou já saiu hoje.
 * Um item cancelado ou pausado não conta: o operador ter descartado dez
 * prospecções e ainda assim ter direito às vinte é o comportamento correto —
 * o teto existe para segurar o que está indo, não o que foi jogado fora.
 */
export function contarAbordagensDeHoje(
  itens: readonly { tipo: TipoDeEnvio; status: string; enviadoEm: string | null; criadoEm: string }[],
  diaDeHojeUtc: string,
): number {
  return itens.filter((item) => {
    if (!consomeLimiteDiario(item.tipo)) return false;
    if (item.status === "cancelled" || item.status === "paused") return false;
    if (item.enviadoEm) return item.enviadoEm.slice(0, 10) === diaDeHojeUtc.slice(0, 10);
    return item.criadoEm.slice(0, 10) === diaDeHojeUtc.slice(0, 10);
  }).length;
}

/**
 * Veredito para UM item. Não trava resposta nem follow-up em nada de jeito:
 * o teto é sobre abordagens frias, e travá-lo com quem está esperando é
 * trocar um problema pequeno por um perda de venda.
 */
export function avaliarLimiteDiario(entrada: EntradaDoLimite): VereditoDoLimite {
  if (!consomeLimiteDiario(entrada.tipo)) return { permite: true, restantes: null };
  if (entrada.limite <= 0) return { permite: true, restantes: null };
  const restantes = Math.max(0, entrada.limite - entrada.abordagensHoje);
  return restantes > 0
    ? { permite: true, restantes }
    : { permite: false, motivo: "limite_diario_de_abordagens", restantes: 0 };
}