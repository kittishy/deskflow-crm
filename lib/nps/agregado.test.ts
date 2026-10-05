/**
 * O NPS É UM NÚMERO QUE MUDA DECISÃO — por isso o agregado é puro e testado.
 *
 * O que este arquivo prende, em ordem de custo:
 *
 *  1. **A faixa.** 9-10 promotor, 7-8 neutro, 0-6 detrator. Um `<` trocado por
 *     `<=` aqui move gente entre "promotor" e "neutro" sem nenhum sintoma: o
 *     número sai plausível e errado.
 *  2. **A amostra mínima.** Um NPS de uma resposta só é artefato da amostra, não
 *     medida — e `-100` numa tela é lido como "o cliente odeia". Mesma decisão do
 *     piso de 5 decisões da taxa de aceite (`app/api/v1/cron/proposal-acceptance-rate`).
 *  3. **A pergunta sem resposta.** `perguntadas` e `respondidas` são coisas
 *     diferentes, e o agregado que as troca mostra uma taxa de resposta de 100%
 *     numa org que ninguém respondeu.
 *  4. **O score fora da faixa.** O CHECK do banco impede; se um dia ele não
 *     impedir, o agregado CONTA o descarte em vez de engolir — uma linha
 *     corrompida que some no silêncio é o defeito que ninguém denuncia.
 */
import { describe, expect, it } from "vitest";

import { agregaNps, classifica, MINIMO_DE_RESPOSTAS } from "./agregado";

const RESPONDIDA = (score: number) => ({ score, answered_at: "2026-10-01T12:00:00.000Z" });
const SEM_RESPOSTA = { score: null, answered_at: null };

describe("classifica", () => {
  it("a fronteira é 9/10 = promotor, e o 10 é o único que não é perfeito por acaso", () => {
    expect(classifica(9)).toBe("promotor");
    expect(classifica(10)).toBe("promotor");
  });

  it("7 e 8 são neutros — e o 6 é detrator", () => {
    expect(classifica(7)).toBe("neutro");
    expect(classifica(8)).toBe("neutro");
    expect(classifica(6)).toBe("detrator");
  });

  it("0 é detrator: o número fecha em zero, não em 'sem nota'", () => {
    expect(classifica(0)).toBe("detrator");
  });

  it("qualquer valor fora de 0..10, ou fracionário, é NENHUMA faixa", () => {
    // `null` e não exceção: o agregado chama isto linha a linha e uma nota
    // corrompida não pode derrubar a tela inteira que mostra o número.
    expect(classifica(-1)).toBeNull();
    expect(classifica(11)).toBeNull();
    expect(classifica(7.5)).toBeNull();
    expect(classifica(Number.NaN)).toBeNull();
  });
});

describe("agregaNps", () => {
  it("sem resposta nenhuma: zero perguntadas, NPS ausente — nunca 0", () => {
    // `nps: 0` aqui seria o pior defeito possível: "ninguém respondeu" lido como
    // "todo mundo é detrator".
    const r = agregaNps([SEM_RESPOSTA, SEM_RESPOSTA]);
    expect(r).toEqual({
      perguntadas: 2,
      respondidas: 0,
      promotores: 0,
      neutros: 0,
      detratores: 0,
      descartadas: 0,
      nps: null,
      taxa_de_resposta: 0,
    });
  });

  it("abaixo da amostra mínima o NPS é ausente, mesmo com todos detratores", () => {
    const r = agregaNps([RESPONDIDA(0), RESPONDIDA(1)]);
    expect(r.respondidas).toBe(2);
    expect(r.nps).toBeNull();
    // A contagem continua à mostra: o operador vê que houve resposta e que o
    // número está fora da amostra, em vez de ver "sem dados" e achar que ninguém
    // respondeu.
    expect(r.detratores).toBe(2);
    expect(MINIMO_DE_RESPOSTAS).toBe(5);
  });

  it("na amostra mínima o número aparece, e é (promotores - detratores)/total", () => {
    // 5 promotores, 3 neutros, 2 detratores → (5 - 2) / 10 = 30.
    const respostas = [
      ...Array.from({ length: 5 }, () => RESPONDIDA(9)),
      ...Array.from({ length: 3 }, () => RESPONDIDA(8)),
      ...Array.from({ length: 2 }, () => RESPONDIDA(3)),
    ];
    const r = agregaNps(respostas);
    expect(r.respondidas).toBe(10);
    expect(r.promotores).toBe(5);
    expect(r.neutros).toBe(3);
    expect(r.detratores).toBe(2);
    expect(r.nps).toBe(30);
  });

  it("todos promotores dá +100, todos detratores dá -100", () => {
    expect(agregaNps(Array.from({ length: 5 }, () => RESPONDIDA(10))).nps).toBe(100);
    expect(agregaNps(Array.from({ length: 5 }, () => RESPONDIDA(0))).nps).toBe(-100);
  });

  it("a neutra não conta para o NPS, e é por isso que ela existe", () => {
    // 4 promotores + 6 neutras: os neutros pagam o total e não entram no
    // numerador. Escrever isso como "promotores - detratores sobre respondidas
    // menos neutros" daria 100 numa org que só tem gente neutra e meia-dúzia
    // de felizes — o número mais lisonjeiro possível, e o menos honesto.
    const r = agregaNps([
      ...Array.from({ length: 4 }, () => RESPONDIDA(10)),
      ...Array.from({ length: 6 }, () => RESPONDIDA(7)),
    ]);
    expect(r.neutros).toBe(6);
    expect(r.nps).toBe(40);
  });

  it("perguntada e respondida são coisas diferentes: a taxa de resposta usa as duas", () => {
    const r = agregaNps([
      RESPONDIDA(9),
      RESPONDIDA(9),
      RESPONDIDA(9),
      RESPONDIDA(9),
      RESPONDIDA(9),
      SEM_RESPOSTA,
      SEM_RESPOSTA,
    ]);
    expect(r.perguntadas).toBe(7);
    expect(r.respondidas).toBe(5);
    expect(r.taxa_de_resposta).toBeCloseTo(71.43, 2);
  });

  it("score fora da faixa é DESCONTADO, não engolido", () => {
    const r = agregaNps([
      ...Array.from({ length: 5 }, () => RESPONDIDA(10)),
      { score: 42, answered_at: "2026-10-01T12:00:00.000Z" },
    ]);
    expect(r.descartadas).toBe(1);
    expect(r.respondidas).toBe(5);
    expect(r.nps).toBe(100);
  });

  it("linha respondida com nota NULA é pergunta sem resposta, não nota quebrada", () => {
    const r = agregaNps([{ score: null, answered_at: "2026-10-01T12:00:00.000Z" }]);
    expect(r.perguntadas).toBe(1);
    expect(r.respondidas).toBe(0);
    expect(r.descartadas).toBe(0);
  });

  it("o NPS sai inteiro, que é como a régua é lida", () => {
    // 3 promotores, 0 neutros, 2 detratores = 100/5 = 20 exato. Este caso existe
    // para o arredondamento não ser testado por acidente num número redondo.
    const r = agregaNps([
      ...Array.from({ length: 3 }, () => RESPONDIDA(10)),
      ...Array.from({ length: 2 }, () => RESPONDIDA(0)),
    ]);
    expect(r.nps).toBe(20);
  });
});
