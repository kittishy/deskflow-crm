/**
 * O painel público em NÚMERO PURO — a camada que decide o que pode ser lido por
 * quem não tem sessão nenhuma na organização dona.
 *
 * ─── Por que isto é uma função pura e não uma rota ───────────────────────────
 *
 * `public_panels` não tem sessão para consultar: a credencial é o UUID da linha,
 * e a organização vem DA LINHA (`lib/painel-publico/resolver.ts`). Um painel
 * compartilhado com cliente não pode depender de cookie — nem do painel, nem de
 * quem abre. Por isso a conta mora aqui, recebe o que foi lido e devolve o que
 * pode ser publicado; a rota e a página são as duas que a chamam.
 *
 * ─── As três regras que este arquivo existe para não deixar errar ─────────────
 *
 * 1. **AUSÊNCIA DE DADO É `null`, NUNCA `0`.** A lei é de `lib/metrics/atrito.ts`
 *    e vale aqui com mais força: quem lê é gente de fora. Uma org sem nenhum
 *    negócio encerrado veria "0% de conversão" e leria isso como "não convertemos
 *    nada" — a frase que a falta de medição não autoriza. Denominador zero
 *    devolve `null` e a tela escreve "—".
 *
 * 2. **NENHUM PAR DE MEDIDA FICA SOZINHO** (doutrina §3.3). Painel público é onde
 *    a tentação de mostrar só o número que sobe é maior: quanto maior a
 *    conversão, melhor. As medidas saem de `montarPares` — a montagem testada do
 *    Índice de Atrito — e por isso cada uma JÁ vem com o dano que provoca. Nada
 *    aqui calcula razão própria: uma fórmula reimplementada neste módulo é a
 *    primeira que diverge na próxima mudança de régua lá.
 *
 * 3. **SAÍDA SEM PII.** Só agregados: contagens, razões e rótulos de
 *    configuração do funil (`settings.lost_reasons`). Nunca nome, telefone,
 *    `user_id`, nem o motivo cru de cada perda. O gate é mecânico, em
 *    `metricas.test.ts`: uma lista de chaves proibidas na saída, porque revisão
 *    humana não pega o campo que alguém acha "inofensivo" numa tela pública.
 */

import { montarPares, razao, type AtritoRaw, type Medida, type Par } from "@/lib/metrics/atrito";
import type { Contagem, RelatorioDePerdas } from "@/lib/metrics/perdas";

/** O que a linha do painel chama de "últimos N dias" quando ninguém configurou. */
export const JANELA_PADRAO_DIAS = 30;
export const JANELA_MIN_DIAS = 1;
/** Teto da janela pública: 5 anos de histórico não é um painel, é um dump. */
export const JANELA_MAX_DIAS = 365;
/** Quantas categorias de perda cabem na tela pública. O total NÃO é cortado. */
export const CATEGORIAS_PUBLICADAS = 5;

const DIA_MS = 24 * 60 * 60 * 1000;

export interface Janela {
  /** ISO-8601 UTC, semiaberta como o resto do produto: `[de, ate)`. */
  de: string;
  ate: string;
  /** Os dias EFETIVOS depois do recorte — o que a régua realmente usou. */
  dias: number;
}

/**
 * O dia da linha é `int` no banco, mas quem chama não é o banco: é a rota lendo
 * um dublê, e a tela mandando o que o formulário aceitou. `typeof` vem ANTES do
 * `Number()` por um motivo concreto: `Number(true)` é `1`, que é inteiro e cai
 * dentro da faixa — um `true` solto passaria como "painel do último dia", que é
 * um número que não mente, e por isso mesmo é o pior dos erros.
 */
function diaDaLinha(cru: unknown): number | null {
  if (typeof cru !== "number" && typeof cru !== "string") return null;
  const dias = Number(cru);
  if (!Number.isFinite(dias) || !Number.isInteger(dias)) return null;
  return dias;
}

/**
 * A janela da linha do painel, já presa na faixa.
 *
 * `0` e negativo são AUSÊNCIA de janela, não janela curta: um painel que mostra
 * um dia e diz "últimos 0 dias" é pior que um painel de 30 dias honesto, porque
 * o rótulo mente sobre o recorte e ninguém tem como saber que mentiu. Pedido
 * acima do teto é PRENDE, não ausência — 400 dias vira 365 com a régua publicada.
 *
 * Um valor fora da faixa não derruba o painel e não vira `NaN` no rótulo que a
 * tela exibe. A régua PUBLICADA é a efetiva (`dias`), nunca a pedida — índice
 * cuja definição muda sem avisar destrói a única coisa que ele tinha, que é
 * comparabilidade no tempo (doutrina §3.4, regra 4).
 */
export function resolverJanela(dias: unknown, agora: Date): Janela {
  const lido = diaDaLinha(dias);
  const efetivo =
    lido === null || lido < JANELA_MIN_DIAS ? JANELA_PADRAO_DIAS : Math.min(JANELA_MAX_DIAS, lido);
  return {
    de: new Date(agora.getTime() - efetivo * DIA_MS).toISOString(),
    ate: agora.toISOString(),
    dias: efetivo,
  };
}

/**
 * O que entra na conta. `atrito: null` significa **não medido** — o painel
 * publica a lista de medidas vazia em vez de zeros. O chamador (rota/página) é
 * quem decide o fallback de banco; aqui a distinção entre "zero" e "não medido"
 * continua visível.
 */
export interface EntradaDasMetricas {
  janela: Janela;
  /** Negócios com `status = 'won'` fechados dentro da janela. */
  ganhos: number;
  /** Negócios com `status = 'lost'` fechados dentro da janela. */
  perdidos: number;
  conversas: number;
  atrito: AtritoRaw | null;
  /** Saída de `agruparPerdas` (`lib/metrics/perdas.ts`) — a conta já é testada. */
  perdas: RelatorioDePerdas;
}

export interface ResumoPublico {
  negocios_ganhos: number;
  negocios_perdidos: number;
  negocios_encerrados: number;
  conversas: number;
  /** `ganhos / (ganhos + perdidos)` — `null` quando nada foi encerrado. */
  taxa_de_conversao: number | null;
}

export interface MetricasPublicas {
  janela: Janela;
  resumo: ResumoPublico;
  perda: {
    total: number;
    por_categoria: Contagem[];
    /** A lista foi cortada para caber na tela. O `total` é o total mesmo. */
    categorias_truncadas: boolean;
  };
  medidas: Par[];
}

/**
 * As DUAS medidas que o painel público publica, e o resto fora.
 *
 * Escolha, não herança: `montarPares` devolve quatro pares e dois deles falam
 * de operação interna — "custo humano" (intervenções, espera na fila, retrabalho
 * do time) e "contenção" (vetos, execuções). Para quem opera, é o painel que
 * ele precisa; para quem recebeu um link, é detailhe de casa alheia. O que fica
 * é a conversão e a automação, cada uma com o dano que provoca — inclusive o
 * abandono no silêncio e o contorno pelo celular, que são os dois que mais
 * custam e os dois que ninguém reporta sozinho.
 */
const MEDIDAS_PUBLICAS = ["conversao", "automacao"] as const;

export function montarMetricasPublicas(entrada: EntradaDasMetricas): MetricasPublicas {
  const { janela, ganhos, perdidos, conversas, atrito, perdas } = entrada;
  const encerrados = ganhos + perdidos;

  const ordenadas = [...perdas.porCategoria].sort(
    (a, b) => b.quantidade - a.quantidade || a.chave.localeCompare(b.chave, "pt-BR"),
  );

  return {
    janela,
    resumo: {
      negocios_ganhos: ganhos,
      negocios_perdidos: perdidos,
      negocios_encerrados: encerrados,
      conversas,
      taxa_de_conversao: razao(ganhos, encerrados),
    },
    perda: {
      total: perdas.total,
      por_categoria: ordenadas.slice(0, CATEGORIAS_PUBLICADAS),
      categorias_truncadas: ordenadas.length > CATEGORIAS_PUBLICADAS,
    },
    // `montarPares` só é chamado com dado: sem `AtritoRaw` não há par para montar,
    // e montar com zeros publicaria "0% de abandono" como se fosse medido.
    medidas: atrito === null ? [] : paresPublicaveis(atrito),
  };
}

/** Os pares publicados, com os rótulos que fazem sentido fora da casa. */
function paresPublicaveis(raw: AtritoRaw): Par[] {
  return montarPares(raw)
    .filter((par) => (MEDIDAS_PUBLICAS as readonly string[]).includes(par.chave))
    .map((par) => ({
      ...par,
      danos: par.danos.map((medida) => medidaPublicavel(medida)),
    }));
}

/**
 * A ressalva que viaja com a medida pública.
 *
 * Duas ressalvas do painel interno NÃO vão para cá, e a omissão é deliberada:
 * a de "quem atende em `visibility_mode='own'` vê só as conversas dele"
 * (`lib/metrics/atrito.ts`) descreve um recorte de PERFIL que não existe neste
 * caminho — a leitura é org-wide, por service role, sobre um painel que a própria
 * organização optou por publicar. Publicá-la seria descrever um risco que o
 * leitor não tem. As demais são denominadores e réguas, e continuam: número sem
 * denominador é o defeito que a doutrina §3.4 proíbe.
 */
const RESSALVAS_DE_PERFIL = /visibility_mode/;

function medidaPublicavel(medida: Medida): Medida {
  return medida.nota && RESSALVAS_DE_PERFIL.test(medida.nota)
    ? { chave: medida.chave, rotulo: medida.rotulo, valor: medida.valor, unidade: medida.unidade }
    : medida;
}
