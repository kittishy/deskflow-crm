"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  /** Os filtros ligados, já em português — ex.: ["Busca", "Etiqueta"]. */
  filtros: string[];
  /** Desliga os filtros. Ausente, quem renderiza não oferece o botão. */
  onLimpar?: () => void;
}

/**
 * O vazio que NÃO mente, no quadro.
 *
 * Espelha `components/inbox/EmptyPorFiltro.tsx`: com filtros zerando os leads,
 * o quadro não pode afirmar "pipeline vazia" — ele nomeia os filtros ativos e
 * oferece a saída. Renderizado ACIMA das colunas, nunca no lugar delas.
 */
export function EmptyPorFiltro({ filtros, onLimpar }: Props) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t("Nenhum lead com esses filtros")}
      className="flex flex-col gap-3 py-2 sm:flex-row sm:items-center sm:justify-between"
    >
      <div role="status" className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-text">{t("Nenhum lead com esses filtros")}</p>
        {filtros.length > 0 && (
          <p className="text-xs text-text-muted">
            {t("Ativos:")} {filtros.map((f) => t(f)).join(" · ")}
          </p>
        )}
      </div>
      {onLimpar && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 self-start sm:self-auto"
          onClick={onLimpar}
        >
          {t("Limpar filtros")}
        </Button>
      )}
    </div>
  );
}
