/**
 * QUANDO PERGUNTAR "COMO FOI?" — e, antes disso, quando NÃO.
 *
 * ## O que este arquivo é
 *
 * A REGRA do disparo, pura: dado o estado de uma conversa fechada, o canal que
 * a atendeu e o que a organização marcou, diz se a pesquisa sai agora, se sai
 * por modelo aprovado, ou se não sai — e **por quê**. O texto é o mesmo para
 * toda instalação; quem liga é a organização (fail-closed).
 *
 * ## Por que a regra mora isolada
 *
 * As três decisões caras aqui são impossíveis de exercitar contra o banco: uma
 * conversa fechada há duas horas, uma janela de 24 h fechada com o cliente
 * calado, um contato que já respondeu ontem. Com a regra dentro da rota, cada
 * uma delas viraria um teste de integração que precisa de relógio, de sessão de
 * canal e de um númerobanido de mentira. Puras, viram tabelas.
 *
 * ## ⚠️ A JANELA DE 24 H É O LIMITE, E ELE É DO CANAL — NÃO NOSSO
 *
 * `lib/channels/capabilities.ts` é o único lugar que sabe o que cada canal
 * permite. Nos canais que aceitam texto livre a qualquer hora, a pesquisa sai
 * como texto comum. Nos canais de hetero-restrição (API oficial e o parceiro que
 * a intermedia), texto livre só passa enquanto o cliente escreveu nas últimas
 * 24 h: fora disso, **só modelo aprovado** — a plataforma recusa com 131047, e
 * mandar o modelo NÃO abre a janela (só o cliente abre, respondendo).
 *
 * Daí a consequência que este arquivo deixa visível: **fora da janela e sem
 * modelo aprovado, a pesquisa não sai.** Não há nome de modelo inventado, não há
 * texto livre "tentando" — quem não tem modelo configurado simplemente não
 * recebe a pergunta, e a linha `nps_responses` nem é criada (ninguém guarda
 * token de convite que não foi enviado).
 *
 * ## ⚠️ O COOLDOWN É POR CONTATO, E POR QUE 90 DIAS
 *
 * A pergunta é sobre um atendimento. Perguntar sobre o atendimento de março
 * quando o cliente foi atendido hoje é ruído que ele responde por costume — e
 * o custo é o número dele: quem recebe pergunta demais é quem para. O mesmo
 * cooldown aparece no `growth-manager` (referência dada no pedido), e aqui ele
 * vive na consulta das respostas recentes do MESMO contato, não numa coluna.
 *
 * ## ⚠️ PERGUNTAR É MENSAGEM A UM SER HUMANO — e por isso a ordem dos testes
 *
 * A ordem das recusas não é estética. `nps_desligado` vem PRIMEIRO: com a
 * pesquisa desligada, nenhuma outra pergunta é respondida — nem "só pra saber se
 * teria telefone". `opt_out` vem logo depois: quem mandou STOP não volta a
 * receber nada, e o produto que gera o STOP é justamente este (`lib/opt-out/`).
 */
import { describe, expect, it } from "vitest";

import { windowRemainingMs } from "@/lib/agent-engine/guardrails/messaging-window";

import {
  COOLDOWN_POR_CONTATO_MS,
  ESPERA_MINIMA_APOS_FECHAR_MS,
  configDoNps,
  criarLinkDaPesquisa,
  decideDisparo,
  npsHabilitado,
  textoDaPesquisa,
  type EntradaDaDecisao,
} from "./disparo";

const AGORA = new Date("2026-10-02T15:00:00.000Z");
const HORA = 3_600_000;

/** Uma conversa fechada há 6 h, respondida há 1 h: dentro de tudo. */
function base(extra: Partial<EntradaDaDecisao> = {}): EntradaDaDecisao {
  return {
    agora: AGORA,
    ligado: true,
    fechadoEm: new Date(AGORA.getTime() - 6 * HORA).toISOString(),
    ultimoInboundEm: new Date(AGORA.getTime() - 1 * HORA).toISOString(),
    telefone: "+5532984000000",
    optOut: false,
    isGroup: false,
    urlPublica: "https://crm.exemplo.com",
    exigeModeloForaDaJanela: false,
    modeloAprovado: null,
    perguntadoEm: null,
    ultimoContatoPerguntadoEm: null,
    ...extra,
  };
}

describe("npsHabilitado", () => {
  it("ausente = desligado: falha fechada, como todo capability deste produto", () => {
    expect(npsHabilitado(undefined)).toBe(false);
    expect(npsHabilitado(null)).toBe(false);
    expect(npsHabilitado({})).toBe(false);
    expect(npsHabilitado({ nps: {} })).toBe(false);
  });

  it("só o booleano true liga — string, número e truthy não", () => {
    // `"true"` na mão de quem edita o JSON do banco parece ligado e não está:
    // a feature inteira morreria calada, e "ninguém foi perguntado" é
    // indistinguível de "está funcionando".
    expect(npsHabilitado({ nps: { enabled: true } })).toBe(true);
    expect(npsHabilitado({ nps: { enabled: "true" } })).toBe(false);
    expect(npsHabilitado({ nps: { enabled: 1 } })).toBe(false);
  });

  it("nps que não é objeto não liga — e não lança", () => {
    expect(npsHabilitado({ nps: "sim" })).toBe(false);
    expect(npsHabilitado({ nps: [] })).toBe(false);
    expect(npsHabilitado("nps")).toBe(false);
    expect(npsHabilitado(42)).toBe(false);
  });
});

describe("configDoNps — o modelo que sai quando a janela está fechada", () => {
  it("sem modelo cadastrado o campo é nulo: o nome do modelo não se inventa", () => {
    expect(configDoNps({ nps: { enabled: true } }).modelo).toBeNull();
    expect(configDoNps({ nps: { enabled: true, template_name: "   " } }).modelo).toBeNull();
    expect(configDoNps({ nps: { enabled: true, template_name: 7 } }).modelo).toBeNull();
  });

  it("modelo sem idioma cai no idioma padrão — sem ele o envio nem sai", () => {
    expect(configDoNps({ nps: { enabled: true, template_name: "nps_v1" } }).modelo).toEqual({
      nome: "nps_v1",
      idioma: "pt_BR",
    });
  });

  it("idioma declarado é respeitado: pt_BR e pt são modelos DISTINTOS", () => {
    expect(
      configDoNps({ nps: { enabled: true, template_name: "nps_v1", template_language: "es" } })
        .modelo,
    ).toEqual({ nome: "nps_v1", idioma: "es" });
  });

  it("o modelo cadastrado não liga a pesquisa: são duas decisões independentes", () => {
    // O contrário também: desligar não apaga o modelo cadastrado, para a
    // organização poder religar sem perder o que aprovou na plataforma.
    expect(npsHabilitado({ nps: { enabled: false, template_name: "nps_v1" } })).toBe(false);
    expect(configDoNps({ nps: { enabled: false, template_name: "nps_v1" } }).modelo?.nome).toBe(
      "nps_v1",
    );
  });
});

describe("decideDisparo — as recusas, na ordem em que mandam", () => {
  it("organização sem NPS ligado: nada sai, e nenhuma outra pergunta é feita", () => {
    const d = decideDisparo(base({ ligado: false }));
    expect(d).toEqual({ dispara: false, viaModelo: false, motivo: "nps_desligado" });
  });

  it("opt-out: quem mandou STOP não recebe a pergunta — e o produto que a gera é este", () => {
    const d = decideDisparo(base({ optOut: true }));
    expect(d.motivo).toBe("opt_out");
    expect(d.dispara).toBe(false);
  });

  it("sem telefone não há a quem perguntar", () => {
    expect(decideDisparo(base({ telefone: null })).motivo).toBe("sem_telefone");
    expect(decideDisparo(base({ telefone: "" })).motivo).toBe("sem_telefone");
  });

  it("conversa de grupo não recebe pergunta individual de satisfação", () => {
    // Um grupo tem várias pessoas e um "como foi?" genérico vira Drucker de
    // grupo: um responde pelo resto.
    expect(decideDisparo(base({ isGroup: true })).motivo).toBe("conversa_de_grupo");
  });

  it("sem fechamento canônico não há pergunta: a pesquisa é sobre um atendimento encerrado", () => {
    expect(decideDisparo(base({ fechadoEm: null })).motivo).toBe("fechamento_ausente");
  });

  it("sem URL pública não há link para mandar", () => {
    const d = decideDisparo(base({ urlPublica: null }));
    expect(d.motivo).toBe("sem_url_publica");
    expect(d.dispara).toBe(false);
  });

  it("o desligamento vence o resto: nem o telefone válido muda o desfecho", () => {
    // A ordem dos testes É o contrato. Se alguém mover a checagem de `optOut`
    // para depois de um `dispara`, este teste é o que avisa.
    expect(decideDisparo(base({ ligado: false, optOut: true })).motivo).toBe("nps_desligado");
  });
});

describe("decideDisparo — o tempo certo de perguntar", () => {
  it("logo depois de fechar é cedo demais: a pessoa pode ainda estar com o problema", () => {
    const d = decideDisparo(
      base({ fechadoEm: new Date(AGORA.getTime() - 10 * 60_000).toISOString() }),
    );
    expect(d.motivo).toBe("ainda_cedo");
  });

  it("espera mínima exata: na fronteira já dispara (o limite é do cron, não da sorte)", () => {
    const d = decideDisparo(
      base({ fechadoEm: new Date(AGORA.getTime() - ESPERA_MINIMA_APOS_FECHAR_MS).toISOString() }),
    );
    expect(d.dispara).toBe(true);
  });

  it("um segundo antes da espera mínima ainda não dispara", () => {
    const d = decideDisparo(
      base({
        fechadoEm: new Date(AGORA.getTime() - ESPERA_MINIMA_APOS_FECHAR_MS + 1000).toISOString(),
      }),
    );
    expect(d.motivo).toBe("ainda_cedo");
  });

  it("passado o prazo a resposta não é mais sobre aquele atendimento", () => {
    const d = decideDisparo(
      base({ fechadoEm: new Date(AGORA.getTime() - 8 * 24 * HORA).toISOString() }),
    );
    expect(d.motivo).toBe("fora_do_prazo");
  });

  it("no prazo exato ainda dispara", () => {
    const d = decideDisparo(
      base({ fechadoEm: new Date(AGORA.getTime() - 7 * 24 * HORA).toISOString() }),
    );
    expect(d.dispara).toBe(true);
  });

  it("fechamento no futuro não dispara — relógio torto não vira pergunta na hora", () => {
    const d = decideDisparo(
      base({ fechadoEm: new Date(AGORA.getTime() + 2 * HORA).toISOString() }),
    );
    expect(d.motivo).toBe("ainda_cedo");
  });

  it("data de fechamento ilegível não derruba a varredura", () => {
    // `new Date("lixo")` dá NaN; comparar com NaN é sempre falso e um `if`
    // escrito como `idade < espera` passaria direto e dispararia. O motivo é
    // explícito para a linha de log dizer o que aconteceu.
    const d = decideDisparo(base({ fechadoEm: "ontem" }));
    expect(d.motivo).toBe("fechamento_ausente");
  });
});

describe("decideDisparo — uma pergunta por conversa, uma a cada 90 dias por contato", () => {
  it("conversa já perguntada não é perguntada de novo", () => {
    const d = decideDisparo(base({ perguntadoEm: new Date(AGORA.getTime() - HORA).toISOString() }));
    expect(d.motivo).toBe("ja_perguntado");
  });

  it("mesmo contato, outra conversa, respondida ontem: cooldown", () => {
    const d = decideDisparo(
      base({ ultimoContatoPerguntadoEm: new Date(AGORA.getTime() - 24 * HORA).toISOString() }),
    );
    expect(d.motivo).toBe("contato_em_cooldown");
  });

  it("cooldown de 90 dias: no limite exato já pode perguntar de novo", () => {
    const d = decideDisparo(
      base({
        ultimoContatoPerguntadoEm: new Date(
          AGORA.getTime() - COOLDOWN_POR_CONTATO_MS,
        ).toISOString(),
      }),
    );
    expect(d.dispara).toBe(true);
  });

  it("perguntado e NÃO respondido também conta: o convite já foi ao cliente", () => {
    // Sem isto, uma conversa que nunca respondeu volta a ser elegível a cada
    // rodada do cron — e a mesma pessoa recebe o link toda hora.
    const d = decideDisparo(
      base({ perguntadoEm: new Date(AGORA.getTime() - 2 * HORA).toISOString() }),
    );
    expect(d.motivo).toBe("ja_perguntado");
  });

  it("o cooldown do contato vale mesmo quando a conversa é outra e o atendimento é novo", () => {
    const d = decideDisparo(
      base({
        fechadoEm: new Date(AGORA.getTime() - 3 * HORA).toISOString(),
        ultimoContatoPerguntadoEm: new Date(AGORA.getTime() - 89 * 24 * HORA).toISOString(),
      }),
    );
    expect(d.motivo).toBe("contato_em_cooldown");
  });
});

describe("decideDisparo — a janela de 24 h decide COMO sai, não SE sai", () => {
  it("canal sem restrição de janela: texto livre, mesmo com o cliente calado há dias", () => {
    const d = decideDisparo(
      base({ ultimoInboundEm: new Date(AGORA.getTime() - 5 * 24 * HORA).toISOString() }),
    );
    expect(d).toEqual({ dispara: true, viaModelo: false, motivo: "enviado" });
  });

  it("canal que exige modelo, cliente dentro da janela: texto livre passa", () => {
    const d = decideDisparo(base({ exigeModeloForaDaJanela: true }));
    expect(d).toEqual({ dispara: true, viaModelo: false, motivo: "enviado" });
  });

  it("canal que exige modelo, janela FECHADA e modelo aprovado: sai pelo modelo", () => {
    const d = decideDisparo(
      base({
        exigeModeloForaDaJanela: true,
        ultimoInboundEm: new Date(AGORA.getTime() - 26 * HORA).toISOString(),
        modeloAprovado: "pesquisa_de_satisfacao_v1",
      }),
    );
    expect(d).toEqual({ dispara: true, viaModelo: true, motivo: "enviado_com_modelo" });
  });

  it("canal que exige modelo, janela FECHADA e SEM modelo aprovado: não sai, e não inventa modelo", () => {
    const d = decideDisparo(
      base({
        exigeModeloForaDaJanela: true,
        ultimoInboundEm: new Date(AGORA.getTime() - 26 * HORA).toISOString(),
        modeloAprovado: null,
      }),
    );
    expect(d).toEqual({ dispara: false, viaModelo: false, motivo: "sem_modelo_aprovado" });
  });

  it("cliente que nunca escreveu conta como janela fechada, não como janela aberta", () => {
    // `last_inbound_at` nulo é o caso do atendimento que começou pelo lado de
    // dentro da empresa. Ler `null` como "acabou de falar" abriria a janela na
    // base e mandaria texto livre para onde a plataforma recusa.
    const d = decideDisparo(
      base({ exigeModeloForaDaJanela: true, ultimoInboundEm: null, modeloAprovado: "x_v1" }),
    );
    expect(d.viaModelo).toBe(true);
  });

  it("a fronteira da janela é a mesma do guardrail do agente", () => {
    // Mesma função, mesmo número: se um dia a janela mudar aqui e não ali, a
    // pesquisa passa a mandar o que o atendimento recusa.
    const dentro = AGORA.getTime() - 23 * HORA;
    expect(windowRemainingMs(AGORA, new Date(dentro))).toBeGreaterThan(0);
    const d = decideDisparo(
      base({ exigeModeloForaDaJanela: true, ultimoInboundEm: new Date(dentro).toISOString() }),
    );
    expect(d.viaModelo).toBe(false);
  });
});

describe("o convite", () => {
  it("o link aponta para a rota pública pelo token — org nenhuma no caminho", () => {
    expect(
      criarLinkDaPesquisa("https://crm.exemplo.com", "11111111-1111-4111-8111-111111111111"),
    ).toBe("https://crm.exemplo.com/api/v1/nps/11111111-1111-4111-8111-111111111111");
  });

  it("barra final não vira barra dupla", () => {
    expect(criarLinkDaPesquisa("https://crm.exemplo.com/", "abc")).toBe(
      "https://crm.exemplo.com/api/v1/nps/abc",
    );
  });

  it("o texto carrega o link e diz o que é: uma nota de 0 a 10", () => {
    const texto = textoDaPesquisa("https://crm.exemplo.com/api/v1/nps/abc");
    expect(texto).toContain("https://crm.exemplo.com/api/v1/nps/abc");
    expect(texto).toMatch(/0\s*(a|ao)\s*10/i);
    // Uma pergunta que pede favoredorismo não é medição — e o texto não pode
    // sugerir resposta, senão o NPS mede a educação do cliente.
    expect(texto).not.toMatch(/recomend|indicaria|estresse|nota 10/i);
  });

  it("o texto do modelo aprovado NÃO recebe o link colado: o link vai no botão", () => {
    // O slot do modelo é preenchido pela tela de modelos; um link no meio do
    // corpo do texto modelado sai errado nos canais que trocam o corpo pela
    // versão aprovada.
    const texto = textoDaPesquisa("{link}", { viaModelo: true });
    expect(texto).toContain("{link}");
  });
});
