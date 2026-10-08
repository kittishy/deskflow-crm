import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { createClient } from "@/lib/supabase/server";
import { lerRitmoEnvio } from "@/lib/messaging/fila/config";
import { traduzir } from "@/lib/i18n/dicionario";
import { RitmoDeEnvioForm } from "./_form";

export const dynamic = "force-dynamic";

/**
 * Configurações → WhatsApp → Ritmo de envio.
 *
 * O guard é o mesmo da action (`podeAdministrarEmpresa`): quem não administra
 * a empresa não vê a tela — e a action recusa de novo, porque tela escondida
 * não é guarda.
 */
export default async function RitmoDeEnvioPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!podeAdministrarEmpresa(user, activeOrg)) redirect("/403");

  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  const ritmo = lerRitmoEnvio(data?.settings ?? null);
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Ritmo de envio", idioma)}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Espaça as mensagens que saem pelo WhatsApp para não parecer disparo em massa. Desligado, o envio segue como antes.",
            idioma,
          )}
        </p>
      </header>
      <RitmoDeEnvioForm initial={ritmo} />
    </div>
  );
}
