/**
 * De QUEM é a falha — e é isso que decide se a campanha inteira para.
 *
 * `campanha`  vale para TODOS os candidatos: canal desconectado, agente sem
 *             versão publicada, configuração inválida. Tentar o próximo daria o
 *             mesmo erro, então pausar é o certo.
 * `candidato` vale só para AQUELE: destino incompleto, abordagem cancelada,
 *             contato que virou bloqueado entre a busca e o envio. Parar a fila
 *             por causa de um item é o oposto do que a casa faz em todo lugar.
 */
export type EscopoDaFalha = "campanha" | "candidato";

export class ProspectingError extends Error {
  constructor(
    message: string,
    public status = 422,
    /**
     * O padrão é `campanha` de propósito: falhar FECHADO.
     *
     * Um erro que ninguém classificou pode ser sistêmico, e marcar o candidato
     * e seguir faria a fila repetir a mesma falha mil vezes — com mil linhas de
     * erro e nenhuma pausa. Pausar uma campanha que podia continuar custa uma
     * retomada manual; não pausar uma que devia parar custa a lista inteira.
     */
    public escopo: EscopoDaFalha = "campanha",
  ) {
    super(message);
  }
}
// Os adapters moram em `lib/prospecting/fontes/` (um por fonte); este módulo
// reexporta o Apify para não quebrar quem já importa daqui.
export { providerRequest, readResults, readSearch, startSearch } from "./fontes/apify";
