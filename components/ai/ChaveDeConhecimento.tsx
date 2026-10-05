"use client";

import { useT } from "@/hooks/i18n/useT";
/**
 * A CHAVE QUE FAZ O MATERIAL VIRAR CONHECIMENTO — dita na tela, resolvida ali.
 *
 * Preparar um material para o agente encontrá-lo exige uma chave de embedding,
 * da OpenAI, OpenRouter ou Google. Antes, a tela de
 * conhecimento prometia "a indexação começa em instantes", o material subia, e
 * numa instalação sem chave nada acontecia — para sempre, sem erro, sem estado,
 * sem aviso.
 *
 * Duas decisões de UX aqui, e as duas são sobre não criar becos:
 *
 *  1. **O aviso vem ANTES do cadastro**, não depois da falha. Descobrir que
 *     faltava chave DEPOIS de subir um PDF de 8 MB é a pior ordem possível.
 *  2. **Dá para resolver sem sair da tela.** O precedente é o passo "o cérebro
 *     dele" do onboarding, que cola a chave dentro do passo que precisa dela.
 *     Mandar a pessoa para outra aba, cadastrar, e voltar é onde se perde gente.
 *
 * Quando JÁ existe chave, o componente não some: ele diz qual está valendo. Sem
 * isso, "por que ele indexou com a chave errada?" não tem resposta na tela.
 *
 * E diz QUEM prepara a base — OpenAI ou Google (contribuição de @vgamkt, #1130) —
 * com a troca ali mesmo. A troca refaz a base inteira, então o aviso vem num
 * diálogo ANTES de trocar, nunca num toast depois.
 */
import { useState } from "react";
import Link from "next/link";
import { CheckCircle, Key, Warning } from "@/lib/ui/icons";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { ProvedorDaBase } from "@/lib/ai/embeddings/chave";
import type { EstadoDaChave } from "@/lib/ai/embeddings/estado";

export type { EstadoDaChave };

type ProvedorDaChave = "openai" | "openrouter" | "google";

const NOME_DO_PROVEDOR: Record<ProvedorDaBase, string> = { openai: "OpenAI", google: "Google" };

const ONDE_PEGAR: Record<ProvedorDaChave, { url: string; texto: string; placeholder: string }> = {
  openai: {
    url: "https://platform.openai.com/api-keys",
    texto: "platform.openai.com/api-keys",
    placeholder: "sk-…",
  },
  openrouter: { url: "https://openrouter.ai/keys", texto: "openrouter.ai/keys", placeholder: "sk-or-…" },
  google: {
    url: "https://aistudio.google.com/apikey",
    texto: "aistudio.google.com/apikey",
    placeholder: "AIza…",
  },
};

interface Props {
  estado: EstadoDaChave;
  /** Chamado depois de cadastrar uma chave, para a tela recarregar o estado. */
  onChaveCadastrada: () => void;
}

export function ChaveDeConhecimento({ estado, onChaveCadastrada }: Props) {
  const t = useT();
  const [abrindo, setAbrindo] = useState(false);
  // A base já tem família e a chave dela sumiu: o cadastro começa nela.
  const semChave = estado.familia_sem_chave;
  const [provedor, setProvedor] = useState<ProvedorDaChave>(semChave ?? "openai");
  const [rotulo, setRotulo] = useState("");
  const [chave, setChave] = useState("");
  const [enviando, setEnviando] = useState(false);
  const nomeDaChave =
    provedor === "openrouter"
      ? t("Chave da OpenRouter")
      : provedor === "google"
        ? t("Chave do Google")
        : t("Chave da OpenAI");

  if (estado.somente_textual) {
    return (
      <div data-testid="conhecimento-busca-textual" className="flex items-center gap-2 text-xs text-text-muted">
        <CheckCircle weight="duotone" className="h-3.5 w-3.5 text-success-fg" aria-hidden />
        <span>
          {t("O acervo usa busca textual em português.")} {t("Esta organização não precisa de chave de embedding; a busca não usa embeddings pagos.")}
        </span>
      </div>
    );
  }

  async function cadastrar() {
    if (chave.trim().length < 8) {
      toast.error(t("Cole a chave inteira antes de salvar."));
      return;
    }
    setEnviando(true);
    try {
      await apiClient.post("/api/v1/ai/credentials", {
        provider: provedor,
        label: rotulo.trim() || nomeDaChave,
        api_key: chave.trim(),
      });
      toast.success(t("Chave salva. Estamos conferindo com o provedor — leva alguns segundos."));
      setChave("");
      setAbrindo(false);
      // Quem recarrega até a validação voltar é o `refetchInterval` do hook: a
      // resposta do POST vem ANTES da confirmação com o provedor, e chamar isto
      // uma vez só deixaria a tela parada no aviso.
      onChaveCadastrada();
    } catch (err) {
      showApiError(err);
    } finally {
      setEnviando(false);
    }
  }

  // A chave existe e ainda não serve: a validação com o provedor está em curso.
  // Sem dizer isto, a tela repete "falta uma chave" para quem acabou de colar
  // uma — e a pessoa cola outra, achando que errou a primeira.
  const conferindo =
    !estado.pode_indexar &&
    estado.credenciais_embedding.some((c) => c.is_active && !c.validated_at && !c.validation_error);

  if (conferindo) {
    return (
      <div
        data-testid="conhecimento-chave-conferindo"
        className="flex items-center gap-2 text-xs text-text-muted"
      >
        <Key className="h-3.5 w-3.5 animate-pulse" aria-hidden />
        <span>{t("Conferindo a chave de embedding — leva alguns segundos.")}</span>
      </div>
    );
  }

  if (estado.pode_indexar) {
    return (
      <div
        data-testid="conhecimento-chave-ok"
        className="flex flex-wrap items-center gap-2 text-xs text-text-muted"
      >
        <CheckCircle weight="duotone" className="h-3.5 w-3.5 text-success-fg" aria-hidden />
        <span>
          {t("Pronto para preparar material.")}{" "}
          {estado.chave_em_uso ? (
            <>
              {t("Usando a chave")}{" "}
              <span className="font-medium text-foreground">{estado.chave_em_uso}</span>.
            </>
          ) : (
            // `explicacao` e `avisos` vêm do servidor, de catálogos fechados
            // (`EXPLICACAO_DA_ORIGEM` em `lib/ai/embeddings/chave.ts`). Passar
            // por um route handler não os tira do alcance do dicionário: a
            // correspondência é por igualdade de string, venha de onde vier.
            estado.explicacao ? t(estado.explicacao) : null
          )}
        </span>
        {estado.avisos.map((a) => (
          <span key={a} className="w-full text-warning-fg">
            {t(a)}
          </span>
        ))}
        {estado.provedor ? (
          <TrocaDeProvedor
            atual={estado.provedor}
            destino={estado.pode_trocar_para}
            onTrocado={onChaveCadastrada}
          />
        ) : null}
      </div>
    );
  }

  return (
    <Card
      data-testid="conhecimento-sem-chave"
      className="space-y-3 border-warning-bg bg-warning-bg/20 p-4"
    >
      <div className="flex items-start gap-2">
        <Warning weight="duotone" className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" aria-hidden />
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {semChave === "google"
              ? t("A base é preparada pelo Google, e a chave do Google não está mais utilizável")
              : semChave === "openai"
                ? t("A base é preparada pela OpenAI, e não há mais chave da OpenAI utilizável")
                : t("Falta uma chave de embedding para o agente aprender o seu material")}
          </h3>
          <p className="text-xs text-text-muted">
            {semChave
              ? // Falha aberta na informação: outra chave cadastrada NÃO assume
                // sozinha — perguntar com outro modelo não acharia nada do que
                // já foi preparado. Quem troca é a pessoa, e a troca refaz a base.
                t(
                  "O agente não consegue consultar o material até isso ser resolvido. Chaves de outro provedor não são usadas sozinhas: o material já preparado só é encontrado com o mesmo provedor. Cadastre a chave de novo ou troque o provedor, o que refaz a base.",
                )
              : t(
                  "O material é preparado pela OpenAI (text-embedding-3-small, também pela OpenRouter) ou pelo Google (gemini-embedding-001). Sem uma dessas chaves, você pode cadastrar o documento, mas ele fica esperando para ser preparado.",
                )}
          </p>
        </div>
      </div>
      {semChave ? (
        <TrocaDeProvedor
          atual={semChave}
          destino={estado.pode_trocar_para}
          onTrocado={onChaveCadastrada}
        />
      ) : null}

      {abrindo ? (
        <div className="space-y-3">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Provedor da chave de embedding")}</legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="embedding-provider"
                  value="openai"
                  checked={provedor === "openai"}
                  onChange={() => setProvedor("openai")}
                  disabled={enviando}
                />
                OpenAI
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="embedding-provider"
                  value="openrouter"
                  data-testid="conhecimento-provedor-openrouter"
                  checked={provedor === "openrouter"}
                  onChange={() => setProvedor("openrouter")}
                  disabled={enviando}
                />
                OpenRouter
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="embedding-provider"
                  value="google"
                  data-testid="conhecimento-provedor-google"
                  checked={provedor === "google"}
                  onChange={() => setProvedor("google")}
                  disabled={enviando}
                />
                Google
              </label>
            </div>
            <p className="text-xs text-text-muted">
              {t("O texto dos materiais é enviado ao provedor escolhido para preparar a busca.")}
            </p>
          </fieldset>
          <div className="space-y-1">
            <Label htmlFor="chave-rotulo">{t("Como você quer chamar esta chave")}</Label>
            <Input
              id="chave-rotulo"
              value={rotulo}
              onChange={(e) => setRotulo(e.target.value)}
              placeholder={nomeDaChave}
              disabled={enviando}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="chave-valor">{nomeDaChave}</Label>
            <Input
              id="chave-valor"
              data-testid="conhecimento-chave-input"
              type="password"
              placeholder={ONDE_PEGAR[provedor].placeholder}
              value={chave}
              onChange={(e) => setChave(e.target.value)}
              disabled={enviando}
              autoComplete="off"
            />
            <p className="text-xs text-text-muted">
              {t("Você pega em")}{" "}
              <a
                href={ONDE_PEGAR[provedor].url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-4"
              >
                {ONDE_PEGAR[provedor].texto}
              </a>
              . {t("Ela é guardada cifrada e nunca aparece de volta na tela.")}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={cadastrar}
              disabled={enviando}
              data-testid="conhecimento-chave-salvar"
            >
              {enviando ? t("Salvando…") : t("Salvar chave")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAbrindo(false)} disabled={enviando}>
              {t("Cancelar")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAbrindo(true)}
            data-testid="conhecimento-cadastrar-chave"
          >
            <Key className="mr-2 h-3.5 w-3.5" aria-hidden />
            {t("Cadastrar a chave aqui")}
          </Button>
          <span className="text-xs text-text-muted">
            {t("ou veja todas em")}{" "}
            <Link
              href="/app/ai/credentials"
              className="font-medium text-foreground underline underline-offset-4"
            >
              {t("IA › Credenciais")}
            </Link>
          </span>
        </div>
      )}
    </Card>
  );
}

/**
 * "Quem prepara a base" + a troca. O diálogo é o aviso: trocar refaz a base
 * inteira, e até o indexador terminar o agente não acha o que ainda não foi
 * refeito. Quem não tem chave do outro lado recebe o caminho, não um botão
 * que devolveria erro.
 */
function TrocaDeProvedor({
  atual,
  destino,
  onTrocado,
}: {
  atual: ProvedorDaBase;
  destino: ProvedorDaBase | null;
  onTrocado: () => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [trocando, setTrocando] = useState(false);

  async function trocar() {
    if (!destino) return;
    setTrocando(true);
    try {
      const r = await apiClient.put<{ data: { fila: { total: number; emitidos: number } | null } }>(
        "/api/v1/ai/knowledge/provedor",
        { provedor: destino },
      );
      const fila = r.data.fila;
      if (fila && fila.emitidos < fila.total) {
        toast.warning(
          t("Provedor trocado, mas parte do material não entrou na fila. Use “Preparar tudo de novo”."),
        );
      } else if (!fila) {
        toast.warning(
          t("Provedor trocado, mas a base não começou a ser refeita. Use “Preparar tudo de novo”."),
        );
      } else {
        toast.success(t("Provedor trocado. A base está sendo refeita."));
      }
      setAberto(false);
      onTrocado();
    } catch (err) {
      showApiError(err);
    } finally {
      setTrocando(false);
    }
  }

  return (
    <span data-testid="conhecimento-provedor" className="flex w-full flex-wrap items-center gap-2">
      <span>
        {t("Quem prepara a base:")}{" "}
        <span className="font-medium text-foreground">{NOME_DO_PROVEDOR[atual]}</span>.
      </span>
      {destino ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setAberto(true)}
          data-testid="conhecimento-trocar-provedor"
        >
          {destino === "google" ? t("Trocar para o Google") : t("Trocar para a OpenAI")}
        </Button>
      ) : atual === "openai" ? (
        <span>
          {t("Para usar o Google, cadastre a chave dele em")}{" "}
          <Link
            href="/app/ai/credentials"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("IA › Credenciais")}
          </Link>
          .
        </span>
      ) : null}
      <AlertDialog open={aberto} onOpenChange={(v) => !trocando && setAberto(v)}>
        <AlertDialogContent data-testid="conhecimento-trocar-provedor-dialogo">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {destino === "google"
                ? t("Trocar para o Google refaz a base inteira")
                : t("Trocar para a OpenAI refaz a base inteira")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Todo o material é preparado de novo com o novo provedor. Enquanto isso acontece, o agente pode não encontrar o que ainda não foi refeito. O texto dos materiais passa a ser enviado ao novo provedor.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={trocando}>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void trocar();
              }}
              disabled={trocando}
              data-testid="conhecimento-trocar-provedor-confirmar"
            >
              {trocando ? t("Trocando…") : t("Trocar e refazer a base")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
}
