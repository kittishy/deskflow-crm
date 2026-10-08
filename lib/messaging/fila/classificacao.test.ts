import { describe, expect, it } from "vitest";

import {
  JANELA_DE_CONVERSA_ATIVA_MS,
  ORDEM_DE_PRIORIDADE,
  PRIORIDADE,
  ROTULO_DO_TIPO,
  TIPOS_DE_ENVIO,
  classificarEnvio,
  comTipoEscolhido,
  consomeLimiteDiario,
  type RetratoDaConversa,
  type TipoDeEnvio,
} from "./classificacao";

const AGORA = new Date("2026-10-06T09:30:00.000Z");
const emMinutos = (min: number) => new Date(AGORA.getTime() - min * 60_000).toISOString();

const retrato = (over: Partial<RetratoDaConversa> = {}): RetratoDaConversa => ({
  contactId: "c1",
  lastInboundAt: null,
  lastOutboundAt: null,
  awaitingSince: null,
  temFollowUpMarcado: false,
  ...over,
});

describe("classificarEnvio", () => {
  it("contato que falou e ficou sem resposta é RESPOSTA", () => {
    expect(
      classificarEnvio(
        retrato({ lastInboundAt: emMinutos(2), lastOutboundAt: emMinutos(30), awaitingSince: emMinutos(2) }),
        AGORA,
      ),
    ).toBe("resposta");
  });

  it("contato que falou e nós nunca respondemos é RESPOSTA", () => {
    expect(classificarEnvio(retrato({ lastInboundAt: emMinutos(5) }), AGORA)).toBe("resposta");
  });

  it("trocamos nos últimos minutos é CONVERSA ATIVA, mesmo com follow-up marcado", () => {
    expect(
      classificarEnvio(
        retrato({
          lastInboundAt: emMinutos(40),
          lastOutboundAt: emMinutos(2),
          temFollowUpMarcado: true,
        }),
        AGORA,
      ),
    ).toBe("conversa_ativa");
  });

  it("parou há 3 dias: volta a ser FOLLOW-UP, não conversa ativa", () => {
    expect(
      classificarEnvio(
        retrato({
          lastInboundAt: emMinutos(60 * 24 * 3),
          lastOutboundAt: emMinutos(60 * 24 * 3 + 1),
          temFollowUpMarcado: true,
        }),
        AGORA,
      ),
    ).toBe("follow_up");
  });

  it("follow-up marcado, sem troca recente, é FOLLOW-UP", () => {
    expect(
      classificarEnvio(retrato({ lastInboundAt: emMinutos(60 * 24 * 5), lastOutboundAt: null, temFollowUpMarcado: true }), AGORA),
    ).toBe("follow_up");
  });

  it("nunca conversou: é NOVA ABORDAGEM", () => {
    expect(classificarEnvio(retrato(), AGORA)).toBe("prospeccao");
  });

  it("só falamos nós, e foi há muito: é NOVA ABORDAGEM", () => {
    expect(classificarEnvio(retrato({ lastOutboundAt: emMinutos(60 * 24 * 30) }), AGORA)).toBe("prospeccao");
  });

  it("nosso outbound é mais novo que o inbound: não é resposta", () => {
    // Ordenação por `>` e não por `>=`: mensagem no mesmo instante conta como
    // respondida, senão um empate de milissegundo vira "resposta" e trava a fila.
    const mesmo = emMinutos(10);
    expect(classificarEnvio(retrato({ lastInboundAt: mesmo, lastOutboundAt: mesmo }), AGORA)).toBe(
      "conversa_ativa",
    );
  });

  it("data inválida não derruba a inferência: cai no tipo frio", () => {
    // Um `last_inbound_at` corrompido não pode estourar a tela nem inventar uma
    // resposta. Sem o que saber, o item vai pelo caminho normal.
    expect(classificarEnvio(retrato({ lastInboundAt: "não-é-data", lastOutboundAt: null }), AGORA)).toBe(
      "prospeccao",
    );
  });

  it("resposta velha NÃO ocupa a prioridade 0 para sempre", () => {
    // O defeito que a janela no passo 1 segura: um inbound de 3 dias sem
    // resposta mantinha a fila inteira atrás de uma conversa parada.
    const velho = retrato({ lastInboundAt: emMinutos(60 * 24 * 3), lastOutboundAt: null, temFollowUpMarcado: true });
    expect(classificarEnvio(velho, AGORA)).toBe("follow_up");
  });

  it("resposta dentro da janela é RESPOSTA mesmo sem awaiting_since", () => {
    // `awaiting_since` é denormalizado e pode atrasar; a data da mensagem é a
    // verdade. Uma resposta não pode perder a prioridade por causa disso.
    expect(classificarEnvio(retrato({ lastInboundAt: emMinutos(1), awaitingSince: null }), AGORA)).toBe(
      "resposta",
    );
  });
});

describe("prioridade", () => {
  it("a ordem é a do pedido: resposta, conversa ativa, follow-up, prospecção", () => {
    expect(ORDEM_DE_PRIORIDADE).toEqual(["resposta", "conversa_ativa", "follow_up", "prospeccao"]);
  });

  it("prospecção nunca passa na frente de resposta nem de conversa ativa", () => {
    expect(PRIORIDADE.prospeccao).toBeGreaterThan(PRIORIDADE.follow_up);
    expect(PRIORIDADE.follow_up).toBeGreaterThan(PRIORIDADE.conversa_ativa);
    expect(PRIORIDADE.conversa_ativa).toBeGreaterThan(PRIORIDADE.resposta);
  });

  it("menor número sai primeiro, em qualquer par", () => {
    const ordenados = [...TIPOS_DE_ENVIO].sort((a, b) => PRIORIDADE[a] - PRIORIDADE[b]);
    expect(ordenados).toEqual(ORDEM_DE_PRIORIDADE);
  });

  it("todo tipo tem rótulo e só prospecção consome o teto diário", () => {
    for (const tipo of TIPOS_DE_ENVIO) expect(ROTULO_DO_TIPO[tipo]).toBeTruthy();
    expect(consomeLimiteDiario("prospeccao")).toBe(true);
    expect(consomeLimiteDiario("resposta")).toBe(false);
    expect(consomeLimiteDiario("conversa_ativa")).toBe(false);
    expect(consomeLimiteDiario("follow_up")).toBe(false);
  });

  it("a janela de conversa ativa é de 24h", () => {
    expect(JANELA_DE_CONVERSA_ATIVA_MS).toBe(86_400_000);
  });
});

describe("comTipoEscolhido — o override da tela", () => {
  it("respeita a escolha do operador", () => {
    expect(comTipoEscolhido(retrato(), "follow_up", AGORA)).toBe("follow_up");
  });

  it("NÃO deixa rebaixar uma resposta para prospecção", () => {
    // Rebaixar aqui significaria a mensagem do contato que está esperando
    // virar a última da fila, atrás de uma prospecção fria.
    const esperando = retrato({
      lastInboundAt: emMinutos(1),
      lastOutboundAt: null,
      awaitingSince: emMinutos(1),
    });
    expect(comTipoEscolhido(esperando, "prospeccao", AGORA)).toBe("resposta");
  });

  it("permite promover para resposta o que foi inferido como conversa ativa", () => {
    const viva = retrato({ lastInboundAt: emMinutos(5), lastOutboundAt: emMinutos(1) });
    expect(comTipoEscolhido(viva, "resposta", AGORA)).toBe("resposta");
  });

  it("só devolve tipos que existem", () => {
    const validos: TipoDeEnvio[] = ["resposta", "conversa_ativa", "follow_up", "prospeccao"];
    for (const tipo of validos) expect(TIPOS_DE_ENVIO).toContain(tipo);
  });
});