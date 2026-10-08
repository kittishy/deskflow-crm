import Link from "next/link";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { redirect } from "next/navigation";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * Configurações → WhatsApp: o hub das preferências de envio do canal.
 *
 * Hoje só o ritmo de envio mora aqui; a porta existe para o link do registro
 * não apontar para uma rota morta e para o próximo ajuste de envio ter onde
 * aparecer sem redesenhar o menu.
 */
export default async function WhatsAppSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!podeAdministrarEmpresa(user, activeOrg)) redirect("/403");
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("WhatsApp", idioma)}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir("Como as mensagens saem pelo seu número.", idioma)}
        </p>
      </header>
      <Link
        href="/app/settings/whatsapp/ritmo-de-envio"
        className="rounded-md border border-border p-4 text-sm hover:bg-muted/50"
      >
        <span className="font-medium">{traduzir("Ritmo de envio", idioma)}</span>
        <span className="mt-1 block text-muted-foreground">
          {traduzir(
            "Organiza o intervalo entre mensagens individuais para contatos diferentes. Desligado por padrão.",
            idioma,
          )}
        </span>
      </Link>
    </div>
  );
}
