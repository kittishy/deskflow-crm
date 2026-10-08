"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { salvarRitmoDeEnvio } from "@/app/actions/settings/ritmoDeEnvio";
import { ritmoEnvioSchema, type RitmoEnvio } from "@/lib/messaging/fila/config";

/**
 * O formulário de "Ritmo de envio" — as seis chaves de
 * `organizations.settings.ritmo_envio`, com o default desligado.
 *
 * A validação de faixa (máximo ≥ mínimo) roda ANTES de chamar a action: o
 * schema já recusa, e mostrar o erro na hora evita uma ida ao servidor que
 * voltaria com o mesmo "invalid_input".
 */
export function RitmoDeEnvioForm({ initial }: { initial: RitmoEnvio }) {
  const t = useT();
  const [ativo, setAtivo] = useState(initial.ativo);
  const [intervaloMinimo, setIntervaloMinimo] = useState(String(initial.intervalo_minimo_s));
  const [intervaloMaximo, setIntervaloMaximo] = useState(String(initial.intervalo_maximo_s));
  const [priorizar, setPriorizar] = useState(initial.priorizar_conversas_ativas);
  const [pausar, setPausar] = useState(initial.pausar_se_contato_respondeu);
  const [limite, setLimite] = useState(String(initial.limite_diario_prospeccoes));
  const [pendente, iniciar] = useTransition();

  function salvar() {
    const candidato = {
      ativo,
      intervalo_minimo_s: Number(intervaloMinimo),
      intervalo_maximo_s: Number(intervaloMaximo),
      priorizar_conversas_ativas: priorizar,
      pausar_se_contato_respondeu: pausar,
      limite_diario_prospeccoes: Number(limite),
    };
    const parsed = ritmoEnvioSchema.safeParse(candidato);
    if (!parsed.success) {
      toast.error(t("Confira os valores: o intervalo máximo não pode ser menor que o mínimo."));
      return;
    }
    iniciar(async () => {
      const resultado = await salvarRitmoDeEnvio(parsed.data);
      if (resultado.ok) {
        toast.success(t("Ritmo de envio salvo."));
      } else {
        toast.error(t("Não foi possível salvar o ritmo de envio."));
      }
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          aria-label={t("Ligar ritmo de envio")}
          checked={ativo}
          onChange={(e) => setAtivo(e.target.checked)}
        />
        {t("Ligar ritmo de envio")}
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="intervalo-minimo">{t("Intervalo mínimo (segundos)")}</Label>
          <Input
            id="intervalo-minimo"
            type="number"
            min={0}
            value={intervaloMinimo}
            onChange={(e) => setIntervaloMinimo(e.target.value)}
            aria-label={t("Intervalo mínimo (segundos)")}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="intervalo-maximo">{t("Intervalo máximo (segundos)")}</Label>
          <Input
            id="intervalo-maximo"
            type="number"
            min={0}
            value={intervaloMaximo}
            onChange={(e) => setIntervaloMaximo(e.target.value)}
            aria-label={t("Intervalo máximo (segundos)")}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label={t("Priorizar conversas ativas")}
          checked={priorizar}
          onChange={(e) => setPriorizar(e.target.checked)}
        />
        {t("Priorizar conversas ativas")}
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label={t("Pausar se o contato respondeu")}
          checked={pausar}
          onChange={(e) => setPausar(e.target.checked)}
        />
        {t("Pausar se o contato respondeu")}
      </label>

      <div className="flex flex-col gap-1">
        <Label htmlFor="limite-diario">{t("Limite diário de novas abordagens")}</Label>
        <Input
          id="limite-diario"
          type="number"
          min={0}
          value={limite}
          onChange={(e) => setLimite(e.target.value)}
          aria-label={t("Limite diário de novas abordagens")}
        />
      </div>

      <div>
        <Button type="button" disabled={pendente} onClick={salvar}>
          {t("Salvar")}
        </Button>
      </div>
    </Card>
  );
}
