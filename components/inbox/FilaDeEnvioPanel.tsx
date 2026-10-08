"use client";

import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useFilaDeEnvio, useFilaDeEnvioAcoes } from "@/hooks/inbox/useFilaDeEnvio";

/**
 * O contador da fila e o painel ordenado.
 *
 * O botão "Fila de envio: N mensagens" é a porta; o painel mostra a ordem
 * prevista de saída — a mesma do worker — com prévia do corpo e o contato.
 */
export function FilaDeEnvioPanel({ readOnly = false }: { readOnly?: boolean }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const contagem = useFilaDeEnvio({ somenteAguardando: true });
  const fila = useFilaDeEnvio({ enabled: aberto });
  const acoes = useFilaDeEnvioAcoes();

  const aguardando =
    contagem.data && "aguardando" in contagem.data
      ? contagem.data.aguardando
      : undefined;
  const rotulo =
    aguardando === undefined
      ? t("Fila de envio")
      : aguardando === 1
        ? t("Fila de envio: 1 mensagem")
        : `${t("Fila de envio:")} ${aguardando} ${t("mensagens")}`;

  const itens = Array.isArray(fila.data) ? fila.data : undefined;

  return (
    <div className="border-b border-border px-3 py-1.5">
      <button
        type="button"
        aria-expanded={aberto}
        onClick={() => setAberto((v) => !v)}
        className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
      >
        {rotulo}
      </button>
      {aberto && (
        <div className="mt-1.5 max-h-64 overflow-y-auto rounded-md border border-border bg-background p-2">
          {fila.isLoading ? (
            <p className="text-xs text-muted-foreground">{t("Carregando…")}</p>
          ) : fila.isError ? (
            <p className="text-xs text-destructive">{t("Não foi possível carregar a fila de envio.")}</p>
          ) : !itens || itens.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("Nenhuma mensagem na fila.")}</p>
          ) : (
            <ul className="space-y-2">
              {itens.map((item) => (
                <li key={item.id} className="rounded-md border border-border p-2 text-xs">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{item.contato?.nome ?? item.contact_id}</span>
                    <span className="text-muted-foreground">
                      {new Date(item.scheduled_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-muted-foreground">
                    {item.mensagem?.body ?? t("(sem texto)")}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {!readOnly && item.status === "pending" && (
                      <>
                        <button type="button" className="underline underline-offset-2" onClick={() => void acoes.enviarAgora(item.id)}>
                          {t("Enviar agora")}
                        </button>
                        <button type="button" className="underline underline-offset-2" onClick={() => void acoes.pausar(item.id)}>
                          {t("Pausar")}
                        </button>
                        <button type="button" className="underline underline-offset-2" onClick={() => void acoes.cancelar(item.id)}>
                          {t("Cancelar")}
                        </button>
                      </>
                    )}
                    {!readOnly && item.status === "paused" && (
                      <>
                        <button type="button" className="underline underline-offset-2" onClick={() => void acoes.retomar(item.id)}>
                          {t("Retomar")}
                        </button>
                        <button type="button" className="underline underline-offset-2" onClick={() => void acoes.cancelar(item.id)}>
                          {t("Cancelar")}
                        </button>
                      </>
                    )}
                    {item.status === "processing" && (
                      <span className="text-muted-foreground">{t("Enviando…")}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
