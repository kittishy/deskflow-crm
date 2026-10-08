"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { showApiError } from "@/components/feedback/ApiErrorToast";

/**
 * A fila de envio, lida do endpoint canônico.
 *
 * `somenteAguardando` devolve só o número do badge — é o que o painel chama a
 * cada poucos segundos. A lista completa só é buscada quando o painel abre.
 */
export interface ItemDaFila {
  id: string;
  organization_id: string;
  message_id: string;
  contact_id: string;
  conversation_id: string;
  channel_session_id: string;
  tipo: "resposta" | "conversa_ativa" | "follow_up" | "prospeccao";
  status: "pending" | "processing" | "sent" | "paused" | "cancelled" | "failed";
  prioridade: number;
  scheduled_at: string;
  tentativas: number;
  max_tentativas: number;
  enviado_em: string | null;
  pausado_em: string | null;
  pausado_motivo: string | null;
  cancelado_em: string | null;
  falho_em: string | null;
  erro: string | null;
  editada_em: string | null;
  criado_em: string;
  /** O corpo da mensagem, quando o endpoint o inclui. */
  mensagem?: { body?: string | null } | null;
  /** O rótulo do contato, quando o endpoint o inclui. */
  contato?: { nome?: string | null } | null;
}

interface OpcoesDaFila {
  somenteAguardando?: boolean;
  limite?: number;
  enabled?: boolean;
}

export function useFilaDeEnvio(opts: OpcoesDaFila = {}) {
  const org = useActiveOrg();
  const somente = opts.somenteAguardando ?? false;
  return useQuery({
    queryKey: ["fila-de-envio", org?.orgId, somente ? "contagem" : "lista", opts.limite ?? 50],
    queryFn: async () => {
      if (somente) {
        const response = await apiClient.get<{ data: { aguardando: number } }>(
          "/api/v1/fila-de-envio?somente_aguardando=true",
        );
        return response.data;
      }
      const response = await apiClient.get<{ data: ItemDaFila[]; meta: { aguardando: number } }>(
        `/api/v1/fila-de-envio?limite=${opts.limite ?? 50}`,
      );
      return response.data;
    },
    refetchInterval: 10_000,
    enabled: Boolean(org) && (opts.enabled ?? true),
  });
}

/** As quatro ações do item, mais editar — cada uma invalida a fila ao voltar. */
export function useFilaDeEnvioAcoes() {
  const qc = useQueryClient();
  const invalidar = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["fila-de-envio"] }),
    qc.invalidateQueries({ queryKey: ["messages"] }),
  ]);

  const editar = useMutation({
    mutationFn: ({ id, corpo }: { id: string; corpo: string }) =>
      apiClient.patch(`/api/v1/fila-de-envio/${id}`, { acao: "editar", corpo }),
    onSettled: invalidar,
    onError: showApiError,
  });
  const pausar = useMutation({
    mutationFn: (id: string) => apiClient.patch(`/api/v1/fila-de-envio/${id}`, { acao: "pausar" }),
    onSettled: invalidar,
    onError: showApiError,
  });
  const retomar = useMutation({
    mutationFn: (id: string) => apiClient.patch(`/api/v1/fila-de-envio/${id}`, { acao: "retomar" }),
    onSettled: invalidar,
    onError: showApiError,
  });
  const enviarAgora = useMutation({
    mutationFn: (id: string) => apiClient.patch(`/api/v1/fila-de-envio/${id}`, { acao: "enviar_agora" }),
    onSettled: invalidar,
    onError: showApiError,
  });
  const cancelar = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/v1/fila-de-envio/${id}`),
    onSettled: invalidar,
    onError: showApiError,
  });

  return {
    editar: (id: string, corpo: string) => editar.mutateAsync({ id, corpo }).then(() => undefined),
    pausar: (id: string) => pausar.mutateAsync(id).then(() => undefined),
    retomar: (id: string) => retomar.mutateAsync(id).then(() => undefined),
    enviarAgora: (id: string) => enviarAgora.mutateAsync(id).then(() => undefined),
    cancelar: (id: string) => cancelar.mutateAsync(id).then(() => undefined),
  };
}
