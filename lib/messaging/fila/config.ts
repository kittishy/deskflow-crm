/**
 * AS SEIS CONFIGURAÇÕES DE "Ritmo de envio", onde moram e como são lidas.
 *
 * Ficam em `organizations.settings.ritmo_envio` — o mesmo JSONB que guarda o
 * resto das preferências da empresa, lido pelo client de sessão (RLS resolve a
 * org). Não é coluna nova: um campo novo aqui não custa migration, não entra
 * no `lib/database.types.ts` gerado, e a página de Configurações já sabe
 * gravar neste objeto.
 *
 * O default é `ativo: false`. A fila é um recurso novo e ninguém pediu que ela
 * mude o comportamento de uma instalação existente no dia da atualização — o
 * produto é self-host e a atualização não pode mudar o que sai do WhatsApp
 * de quem já operava.
 */
import { z } from "zod";

import { INTERVALO_MAXIMO_TETO_S } from "./agendamento";

/** Chave dentro de `organizations.settings`. */
export const CHAVE_DO_RITMO = "ritmo_envio" as const;

export const ritmoEnvioSchema = z
  .object({
    ativo: z.boolean(),
    intervalo_minimo_s: z.number().int().min(0).max(INTERVALO_MAXIMO_TETO_S),
    intervalo_maximo_s: z.number().int().min(0).max(INTERVALO_MAXIMO_TETO_S),
    priorizar_conversas_ativas: z.boolean(),
    pausar_se_contato_respondeu: z.boolean(),
    limite_diario_prospeccoes: z.number().int().min(0).max(1_000),
  })
  // Faixa invertida é erro de dedo, não estado válido. Recusar na borda é
  // melhor do que normalizar calado: o operador vê o que gravar.
  .refine((v) => v.intervalo_maximo_s >= v.intervalo_minimo_s, {
    message: "O intervalo máximo não pode ser menor que o mínimo.",
    path: ["intervalo_maximo_s"],
  });

export type RitmoEnvio = z.infer<typeof ritmoEnvioSchema>;

export const RITMO_PADRAO: RitmoEnvio = {
  ativo: false,
  intervalo_minimo_s: 90,
  intervalo_maximo_s: 180,
  priorizar_conversas_ativas: true,
  pausar_se_contato_respondeu: true,
  limite_diario_prospeccoes: 20,
};

/**
 * Lê o bloco do JSONB de settings.
 *
 * `safeParse` e, no erro, o default — porque um `settings` gravado por versão
 * antiga (ou editado à mão) pode ter campo faltando, e um campo faltando não
 * pode derrubar a tela de Configurações nem travar o envio do dia. O default
 * de cada campo isolado vem do schema, então uma config pela metade continua
 * legível.
 */
export function lerRitmoEnvio(settings: unknown): RitmoEnvio {
  const bruto =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)[CHAVE_DO_RITMO]
      : undefined;
  if (!bruto || typeof bruto !== "object") return { ...RITMO_PADRAO };

  const candidato: Record<string, unknown> = { ...(bruto as Record<string, unknown>) };
  // Preenche o que falta com o padrão ANTES de validar: um intervalo máximo
  // ausente não pode reprovar a config inteira, senão ligar o recurso exigiria
  // preencher seis campos de uma vez.
  for (const [campo, valor] of Object.entries(RITMO_PADRAO)) {
    if (candidato[campo] === undefined) candidato[campo] = valor;
  }
  const parsed = ritmoEnvioSchema.safeParse(candidato);
  return parsed.success ? parsed.data : { ...RITMO_PADRAO };
}

/** Achata para gravar junto do resto do settings, sem perder os outros campos. */
export function gravarRitmoEnvio(settings: unknown, ritmo: RitmoEnvio): Record<string, unknown> {
  const base =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? { ...(settings as Record<string, unknown>) }
      : {};
  return { ...base, [CHAVE_DO_RITMO]: ritmo };
}

/** A fila só faz algo quando o dono LIGOU. */
export function filaLigada(ritmo: RitmoEnvio): boolean {
  return ritmo.ativo;
}