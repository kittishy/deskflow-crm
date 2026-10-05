/**
 * O painel público em forma de PUREZA: o que sai daqui é o que pode ser lido
 * por quem não tem sessão nenhuma na organização dona.
 *
 * Quatro regras moram neste arquivo de teste, e nenhuma delas é sobre o número:
 *
 * 1. AUSÊNCIA DE DADO É `null`, NUNCA `0` — a mesma lei de `lib/metrics/atrito.ts`.
 *    Denominador zero devolve `null` e a tela mostra "—". Um zero aqui viraria
 *    "0% de conversão" numa org sem nenhum negócio encerrado, que é a frase que
 *    a falta de medição não autoriza.
 * 2. NENHUM PAR DE MEDIDA FICA SOZINHO — eficiência sem dano (doutrina §3.3).
 *    O painel é público, o que aumenta a tentação de mostrar só o número que sobe.
 * 3. A SAÍDA NÃO TEM CHAVE QUE IDENTIFIQUE PESSOA — nem `user_id`, nem nome,
 *    nem telefone. O gate é MECÂNICO (lista de chaves), porque a revisão humana
 *    não pega o campo que alguém achar "inofensivo" numa tela pública.
 * 4. A FÓRMULA NÃO É REESCRITA AQUI — as razões vêm de `lib/metrics/atrito.ts`,
 *    que é onde a regra mora. Um número reimplementado neste módulo é um número
 *    que começa a divergir na primeira mudança de régua lá.
 */

import { describe, expect, it } from "vitest";

import {
  taxaDeAbandono,
  taxaDeAutomacao,
  taxaDeContorno,
  type AtritoRaw,
} from "@/lib/metrics/atrito";
import {
  CATEGORIAS_PUBLICADAS,
  JANELA_MAX_DIAS,
  JANELA_PADRAO_DIAS,
  montarMetricasPublicas,
  resolverJanela,
  type EntradaDasMetricas,
} from "@/lib/painel-publico/metricas";

const AGORA = new Date("2026-10-02T12:00:00.000Z");

/** `AtritoRaw` inteiro, com valor distinto em CADA campo — assim um número
 *  reimplementado com outro campo no lugar denuncia na asserção. */
function atrito(over: Partial<AtritoRaw> = {}): AtritoRaw {
  const base: AtritoRaw = {
    escopo: {
      demandas: 12,
      de: "2026-09-02T12:00:00.000Z",
      ate: AGORA.toISOString(),
      abandono_horas: 72,
      repeticao_min: 0.7,
      espera_horas: 4,
      demandas_com_caso: 9,
      demandas_abertas: 3,
      denominador: "demandas",
    },
    cliente: {
      turnos_p50: 7,
      turnos_p90: 19,
      insistencia_media: 1.2,
      insistencia_max: 4,
      pedidos_de_humano: 3,
      descadastros: 1,
      abandonos: 4,
      conversas_com_fala_nossa: 20,
      reperguntas: 5,
      perguntas_com_resposta: 25,
      esperas_caladas: 3,
      esperas_medidas: 12,
      espera_resposta_p90_s: 90,
      repeticao_pos_passagem: 2,
      passagens_medidas: 8,
    },
    empresa: {
      intervencoes_por_demanda: 0.5,
      espera_humana_p50_s: 120,
      espera_humana_p90_s: 600,
      retrabalho: 2,
      vetos: 1,
      execucoes_medidas: 10,
      // 70 do agente, 20 de gente no sistema, 10 de gente por fora: o total com
      // dono é 100. As 500 de automação e as 30 de integração NÃO entram em
      // nenhuma ponta — ninguém as escreveu.
      envios_por_ia: 70,
      envios_por_automacao: 500,
      envios_por_integracao: 30,
      envios_humano_no_sistema: 20,
      envios_humano_fora: 10,
      demandas_sem_proximo_passo: 2,
    },
    eficiencia: { ganhos: 8, perdidos: 2 },
  };
  return {
    ...base,
    ...over,
    cliente: { ...base.cliente, ...over.cliente },
    empresa: { ...base.empresa, ...over.empresa },
    escopo: { ...base.escopo, ...over.escopo },
    eficiencia: { ...base.eficiencia, ...over.eficiencia },
  };
}

function entrada(over: Partial<EntradaDasMetricas> = {}): EntradaDasMetricas {
  return {
    janela: resolverJanela(30, AGORA),
    ganhos: 8,
    perdidos: 2,
    conversas: 40,
    atrito: atrito(),
    perdas: {
      porMotivo: [
        { chave: "Preço", quantidade: 6 },
        { chave: "Sem resposta", quantidade: 4 },
      ],
      porCategoria: [
        { chave: "Preço", quantidade: 6 },
        { chave: "Timing", quantidade: 4 },
      ],
      porEtapa: [{ chave: "Proposta", quantidade: 10 }],
      porMoeda: [{ moeda: "BRL", quantidade: 10, valor_cents: 50000 }],
      total: 10,
    },
    ...over,
  };
}

/** Toda chave de qualquer objeto do payload, em qualquer profundidade. */
function chaves(obj: unknown, achadas: string[] = []): string[] {
  if (obj === null || typeof obj !== "object") return achadas;
  for (const [chave, valor] of Object.entries(obj)) {
    achadas.push(chave);
    chaves(valor, achadas);
  }
  return achadas;
}

describe("resolverJanela", () => {
  it("usa a janela da linha do painel", () => {
    expect(resolverJanela(7, AGORA)).toEqual({
      de: "2026-09-25T12:00:00.000Z",
      ate: "2026-10-02T12:00:00.000Z",
      dias: 7,
    });
  });

  it("DIA AUSENTE OU INVENTADO cai no default — um painel não nasce sem janela", () => {
    for (const cru of [null, undefined, 0, -3, Number.NaN, "trinta", {}, [], true]) {
      expect(resolverJanela(cru, AGORA).dias).toBe(JANELA_PADRAO_DIAS);
    }
  });

  it("a COLUNA é inteiro mas o texto também é aceito — o valor vem de uma linha que ninguém editou à mão", () => {
    expect(resolverJanela("30", AGORA).dias).toBe(30);
  });

  it("PRENDE na faixa: ninguém publica um painel de 5 anos nem de 12 horas", () => {
    expect(resolverJanela(9999, AGORA).dias).toBe(JANELA_MAX_DIAS);
    expect(resolverJanela(1, AGORA).dias).toBe(1);
  });
});

describe("montarMetricasPublicas", () => {
  it("resume a conta da janela e NUNCA o motivo cru nem o valor em moeda", () => {
    const metricas = montarMetricasPublicas(entrada());
    expect(metricas.resumo).toEqual({
      negocios_ganhos: 8,
      negocios_perdidos: 2,
      negocios_encerrados: 10,
      conversas: 40,
      taxa_de_conversao: 0.8,
    });
    expect(metricas.perda.total).toBe(10);
    expect(metricas.perda.por_categoria).toEqual([
      { chave: "Preço", quantidade: 6 },
      { chave: "Timing", quantidade: 4 },
    ]);
    const serializado = JSON.stringify(metricas);
    expect(serializado).not.toContain("Sem resposta");
    expect(serializado).not.toContain("valor_cents");
  });

  it("sem negócio encerrado a conversão é `null`, e não 0%", () => {
    const metricas = montarMetricasPublicas(entrada({ ganhos: 0, perdidos: 0 }));
    expect(metricas.resumo.taxa_de_conversao).toBeNull();
    expect(metricas.resumo.negocios_encerrados).toBe(0);
  });

  it("as medidas do painel são as do Índice de Atrito, e só as duas que fazem sentido sem login", () => {
    const metricas = montarMetricasPublicas(entrada());
    expect(metricas.medidas.map((m) => m.chave)).toEqual(["conversao", "automacao"]);
    for (const par of metricas.medidas) {
      expect(par.danos.length, `medida "${par.chave}" sem dano`).toBeGreaterThan(0);
      expect(par.eficiencia, `medida "${par.chave}" sem eficiência`).toBeDefined();
    }
  });

  it("A FÓRMULA É A DE `lib/metrics/atrito.ts` — não uma reimplementação", () => {
    const raw = atrito();
    const metricas = montarMetricasPublicas(entrada({ atrito: raw }));
    const porChave = new Map(metricas.medidas.map((m) => [m.chave, m]));

    const conversao = porChave.get("conversao");
    const abandono = conversao?.danos.find((d) => d.chave === "taxa_de_abandono");
    expect(abandono?.valor).toBe(taxaDeAbandono(raw.cliente));

    const automacao = porChave.get("automacao");
    expect(automacao?.eficiencia.valor).toBe(taxaDeAutomacao(raw.empresa));
    const contorno = automacao?.danos.find((d) => d.chave === "taxa_de_contorno");
    expect(contorno?.valor).toBe(taxaDeContorno(raw.empresa));
  });

  it("o número do agente NÃO sobe com as 500 respostas de automação — ninguém as escreveu", () => {
    const raw = atrito();
    const metricas = montarMetricasPublicas(
      entrada({ atrito: { ...raw, empresa: { ...raw.empresa, envios_por_ia: 70 } } }),
    );
    const automacao = metricas.medidas.find((m) => m.chave === "automacao");
    // 70 sobre 70 + 20 + 10. Se a automação ou a integração entrassem no
    // denominador, sairia 70/600 e o painel diria que o time parou de responder.
    expect(automacao?.eficiencia.valor).toBeCloseTo(0.7);
  });

  it("SEM MEDIÇÃO DE ATRITO o painel não inventa zero — a lista de medidas vem vazia", () => {
    const metricas = montarMetricasPublicas(entrada({ atrito: null }));
    expect(metricas.medidas).toEqual([]);
    // O resumo continua: conversas e negócios vêm de outras leituras.
    expect(metricas.resumo.negocios_encerrados).toBe(10);
  });

  it("a janela e a régua viajam com o número — índice sem régua não é comparável no tempo", () => {
    const janela = resolverJanela(7, AGORA);
    expect(montarMetricasPublicas(entrada({ janela })).janela).toEqual(janela);
  });

  it("a categoria sai ORDENADA por quantidade, com desempate estável", () => {
    const metricas = montarMetricasPublicas(
      entrada({
        perdas: {
          porMotivo: [],
          porCategoria: [
            { chave: "Verde", quantidade: 1 },
            { chave: "Azul", quantidade: 5 },
            { chave: "Âmbar", quantidade: 1 },
          ],
          porEtapa: [],
          porMoeda: [],
          total: 7,
        },
      }),
    );
    expect(metricas.perda.por_categoria).toEqual([
      { chave: "Azul", quantidade: 5 },
      { chave: "Âmbar", quantidade: 1 },
      { chave: "Verde", quantidade: 1 },
    ]);
  });

  it("a categoria pode ser CORTADA sem mentir sobre o total", () => {
    const muitas = Array.from({ length: 9 }, (_, i) => ({
      chave: `categoria-${i}`,
      quantidade: 10 - i,
    }));
    const metricas = montarMetricasPublicas(
      entrada({
        perdas: {
          porMotivo: [],
          porCategoria: muitas,
          porEtapa: [],
          porMoeda: [],
          total: 90,
        },
      }),
    );
    expect(metricas.perda.por_categoria).toHaveLength(CATEGORIAS_PUBLICADAS);
    expect(metricas.perda.total).toBe(90);
    expect(metricas.perda.categorias_truncadas).toBe(true);
  });

  it("NENHUMA chave do payload identifica pessoa — gate mecânico, não revisão", () => {
    const proibidas = chaves(montarMetricasPublicas(entrada())).filter((c) =>
      /user_id|owner|phone|telefone|email|nome|name|contact|avatar|wa_lid/i.test(c),
    );
    expect(proibidas).toEqual([]);
  });
});
