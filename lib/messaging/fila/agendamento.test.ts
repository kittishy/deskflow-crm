import { describe, expect, it } from "vitest";

import {
  INTERVALO_MAXIMO_TETO_S,
  normalizarIntervalos,
  podeEnviarAgora,
  proximoLiberadoParaOutroContato,
  proximoSlotDeEnvio,
} from "./agendamento";

const emSegundos = (base: Date, segundos: number): Date => new Date(base.getTime() + segundos * 1000);
const hhmm = (d: Date) => d.toISOString().slice(11, 19);
const AGORA = new Date("2026-10-06T09:30:00.000Z");

describe("proximoSlotDeEnvio — cadeia vazia manda agora", () => {
  it("primeira mensagem, nada enviado e fila vazia: envio imediato", () => {
    const slot = proximoSlotDeEnvio({
      agora: AGORA,
      fimDaCadeia: null,
      intervaloMinimoS: 90,
      intervaloMaximoS: 180,
      sorteio: () => 0,
    });
    expect(slot.getTime()).toBe(AGORA.getTime());
  });
});

describe("proximoSlotDeEnvio — a cadeia comanda", () => {
  it("respeita o mínimo depois do envio para outro contato", () => {
    const slot = proximoSlotDeEnvio({
      agora: AGORA,
      fimDaCadeia: emSegundos(AGORA, -30),
      intervaloMinimoS: 90,
      intervaloMaximoS: 180,
      sorteio: () => 0,
    });
    // Mandou para outro contato às 09:29:30; o mínimo entra uma vez: 09:31:00.
    expect(hhmm(slot)).toBe("09:31:00");
  });

  it("sorteia DENTRO da faixa configurada, e não acima dela", () => {
    const entrada = {
      agora: AGORA,
      fimDaCadeia: new Date("2026-10-06T09:30:00.000Z"),
      intervaloMinimoS: 90,
      intervaloMaximoS: 180,
    };
    // Gap = 90 (mínimo) + sorteio dentro dos 90s restantes.
    expect(hhmm(proximoSlotDeEnvio({ ...entrada, sorteio: () => 0 }))).toBe("09:31:30");
    expect(hhmm(proximoSlotDeEnvio({ ...entrada, sorteio: () => 0.5 }))).toBe("09:32:15");
    expect(hhmm(proximoSlotDeEnvio({ ...entrada, sorteio: () => 0.999999 }))).toBe("09:33:00");
  });

  it("nunca repete o horário do item que já está na fila", () => {
    const itemNaFila = new Date("2026-10-06T09:34:41.000Z");
    const slot = proximoSlotDeEnvio({
      agora: AGORA,
      fimDaCadeia: itemNaFila,
      intervaloMinimoS: 90,
      intervaloMaximoS: 180,
      sorteio: () => 0,
    });
    // É o defeito mais visível de uma fila mal feita: dez bolhas com "09:34".
    expect(hhmm(slot)).toBe("09:36:11");
    expect(slot.getTime()).toBeGreaterThan(itemNaFila.getTime());
  });

  it("fila atrasada não segura a mensagem: manda agora", () => {
    const slot = proximoSlotDeEnvio({
      agora: AGORA,
      fimDaCadeia: new Date("2026-10-06T08:00:00.000Z"),
      intervaloMinimoS: 90,
      intervaloMaximoS: 180,
      sorteio: () => 0,
    });
    // O fim da cadeia já passou do mínimo: segurar mais seria burocracia.
    expect(slot.getTime()).toBe(AGORA.getTime());
  });

  it("faixa invertida não trava a fila: cai no mínimo", () => {
    const slot = proximoSlotDeEnvio({
      agora: AGORA,
      fimDaCadeia: AGORA,
      intervaloMinimoS: 180,
      intervaloMaximoS: 90,
      sorteio: () => 0.5,
    });
    expect(hhmm(slot)).toBe("09:33:00");
    expect(normalizarIntervalos(180, 90)).toEqual({ minS: 180, maxS: 180 });
  });

  it("intervalo zero não trava a fila", () => {
    const slot = proximoSlotDeEnvio({
      agora: AGORA,
      fimDaCadeia: emSegundos(AGORA, -1),
      intervaloMinimoS: 0,
      intervaloMaximoS: 0,
      sorteio: () => 0,
    });
    // Com zero de mínimo, um segundo já cumpriu: manda agora, não trava.
    expect(slot.getTime()).toBe(AGORA.getTime());
  });

  it("monta a sequência do exemplo pedido, sem horário repetido", () => {
    // O exemplo do pedido: 09:30 enviada, e as seguintes caindo dentro da faixa
    // 90–180s, cada uma com um horário próprio.
    let cadeia = new Date("2026-10-06T09:30:00.000Z");
    const sorteios = [0.2, 0.6, 0.1, 0.85];
    const horarios: string[] = [];
    for (const s of sorteios) {
      const slot = proximoSlotDeEnvio({
        agora: AGORA,
        fimDaCadeia: cadeia,
        intervaloMinimoS: 90,
        intervaloMaximoS: 180,
        sorteio: () => s,
      });
      horarios.push(hhmm(slot));
      cadeia = slot;
    }
    // Gaps: 108s, 144s, 99s, 166s — todos dentro de [90, 180].
    expect(horarios).toEqual(["09:31:48", "09:34:12", "09:35:51", "09:38:37"]);
    expect(new Set(horarios).size).toBe(horarios.length);
  });

  it("teto de configuração rejeita faixa absurda", () => {
    expect(normalizarIntervalos(0, 10 ** 9).maxS).toBe(10 ** 9);
    expect(INTERVALO_MAXIMO_TETO_S).toBe(3_600);
  });
});

describe("proximoLiberadoParaOutroContato", () => {
  it("sem cadeia, está liberado agora", () => {
    expect(proximoLiberadoParaOutroContato(AGORA, null, 90).getTime()).toBe(AGORA.getTime());
  });

  it("com envio recente a outro contato, ainda não liberou", () => {
    // 09:29:45 + 90s = 09:31:15, que está no futuro: ainda espera.
    const cadeia = new Date("2026-10-06T09:29:45.000Z");
    expect(hhmm(proximoLiberadoParaOutroContato(AGORA, cadeia, 90))).toBe("09:31:15");
    expect(podeEnviarAgora(AGORA, cadeia, 90)).toBe(false);
  });

  it("mínimo já cumprido devolve agora, não um instante passado", () => {
    // 09:28 + 90s = 09:29:30 já passou: está liberado neste instante.
    const cadeia = new Date("2026-10-06T09:28:00.000Z");
    expect(proximoLiberadoParaOutroContato(AGORA, cadeia, 90).getTime()).toBe(AGORA.getTime());
  });

  it("nunca devolve um instante já passado", () => {
    const cadeia = new Date("2026-10-06T09:29:59.000Z");
    // O mínimo de 0s daria 09:29:59, que é o PASSADO. Quem chamou disso para
    // esperar ficaria esperando para sempre.
    expect(proximoLiberadoParaOutroContato(AGORA, cadeia, 0).getTime()).toBe(AGORA.getTime());
  });
});

describe("podeEnviarAgora", () => {
  it("cadeia vazia: pode", () => {
    expect(podeEnviarAgora(AGORA, null, 90)).toBe(true);
  });

  it("mínimo ainda não passou: não pode", () => {
    expect(podeEnviarAgora(AGORA, emSegundos(AGORA, -30), 90)).toBe(false);
  });

  it("mínimo já passou: pode, mesmo com fila atrasada", () => {
    expect(podeEnviarAgora(AGORA, emSegundos(AGORA, -120), 90)).toBe(true);
  });
});