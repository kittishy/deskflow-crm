/**
 * /painel-publico/[id] — o painel que o cliente recebeu o link para abrir.
 *
 * ─── Por que esta tela não pede sessão ───────────────────────────────────────
 *
 * Quem chega aqui é a pessoa de FORA: o cliente, o parceiro, quem recebeu o
 * link. Não há cookie e não pode haver — se houvesse, o painel só existiria
 * dentro da sessão de quem o compartilhou, e o compartilhamento deixa de existir.
 * Por isso a tela lê direto do `service_role`, pelo mesmo caminho da API
 * (`lib/painel-publico/resolver.ts`), e a organização vem da LINHA do painel.
 *
 * ⚠️ ESTA PÁGINA PRECISA DE ENTRADA EM `lib/auth/public-paths.ts`: o `proxy.ts`
 * redireciona para `/login` qualquer caminho não público sem usuário, e esse
 * arquivo está fora do recorte desta peça.
 *
 * ─── A marca ─────────────────────────────────────────────────────────────────
 *
 * Sai de `marcaDaSaida(organizationId)` — a marca da ORGANIZAÇÃO dona, que é o
 * produto revendido. Nada de nome de produto escrito à mão: `tests/unit/
 * branding.test.ts` varre `app|components|lib` e a allowlist só encolhe. Logo
 * nenhum é desenhado quando não há `logoUrl`, no lugar dele também não.
 *
 * ─── Idioma ──────────────────────────────────────────────────────────────────
 *
 * Tela pública fora de `app/app/`: sem `IdiomaProvider`, sem sessão — o idioma
 * vem de `idiomaDoVisitante`, exatamente como em `app/legal/layout.tsx`. Toda
 * prosa passa por `traduzir()`, porque `tests/unit/i18n-espanhol-cobre-a-tela.ts`
 * varre `app/**` e reprova texto renderizado cru. A chave é o português e o
 * número NUNCA passa por tradução (regra dos rótulos que interpolam).
 *
 * ─── O que a tela NÃO faz ────────────────────────────────────────────────────
 *
 * Não pede `from`/`to` (a janela é da linha), não mostra PII (só agregados de
 * `lib/painel-publico/metricas.ts`), não tem animação — então
 * `prefers-reduced-motion` é respeitado por construção — e o contraste do texto
 * vem das classes de token do produto, nunca da cor da marca.
 */

import { marcaDaSaida } from "@/lib/branding/saida";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";
import { formatarMedida, type Medida } from "@/lib/metrics/atrito";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerMetricasPublicas, resolverPainelPublico } from "@/lib/painel-publico/resolver";
import type { MetricasPublicas } from "@/lib/painel-publico/metricas";

export const dynamic = "force-dynamic";

/**
 * `noindex` deliberado: este é um link de cliente, com número de negócio de
 * alguém. Indexá-lo por acidente é publicar dado de operação sem a organização
 * ter pedido — o oposto do opt-in que a linha `enabled` representa.
 */
export const metadata = {
  title: "Painel de resultados",
  robots: { index: false, follow: false },
};

const numero = new Intl.NumberFormat("pt-BR");

/** O tradutor da tela: a chave é o português, como em toda tela do produto. */
type Tradutor = (texto: string) => string;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O desenho quando não há o que mostrar: existe a tela, e não há número. */
function Cartao({ rotulo, valor, nota }: { rotulo: string; valor: string; nota?: string }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{rotulo}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{valor}</p>
      {nota ? <p className="mt-1 text-xs text-muted-foreground">{nota}</p> : null}
    </div>
  );
}

function LinhaDeMedida({ medida }: { medida: Medida }) {
  return (
    <li className="flex items-baseline justify-between gap-4 border-t py-2">
      <span>
        <span className="text-sm">{medida.rotulo}</span>
        {medida.nota ? (
          <span className="block text-xs text-muted-foreground">{medida.nota}</span>
        ) : null}
      </span>
      <span className="text-sm font-medium tabular-nums">{formatarMedida(medida)}</span>
    </li>
  );
}

/**
 * Sem painel — link trocado, painel desligado ou banco fora do ar.
 *
 * Deliberadamente NEUTRA: sem marca, sem nome de produto e sem repetir o id que
 * foi pedido. Quem chegou com um link quebrado não precisa de um 404 do produto
 * nem de um identificador de instalação para tentar de novo.
 */
function Indisponivel({ t }: { t: Tradutor }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-2 px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">{t("Painel indisponível")}</h1>
      <p className="text-sm text-muted-foreground">
        {t(
          "Este painel não existe, foi desligado ou ainda não está pronto. Peça um link novo a quem acompanha o atendimento.",
        )}
      </p>
    </main>
  );
}

export default async function PainelPublicoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idioma = await idiomaDoVisitante(null);
  const t: Tradutor = (texto) => traduzir(texto, idioma);

  // Forma de UUID validada AQUI, e não só na rota: a página é entrada por link
  // colado no navegador, e um id inventado não é motivo para consultar.
  if (!UUID.test(id)) return <Indisponivel t={t} />;

  const admin = createAdminClient();
  const painel = await resolverPainelPublico(admin, id);
  if (!painel) return <Indisponivel t={t} />;

  const [metricas, marca] = await Promise.all([
    lerMetricasPublicas(admin, painel),
    marcaDaSaida(painel.organizationId),
  ]);

  return <Corpo titulo={painel.title} metricas={metricas} marca={marca} t={t} />;
}

function Corpo({
  titulo,
  metricas,
  marca,
  t,
}: {
  titulo: string;
  metricas: MetricasPublicas;
  marca: { nome: string; logoUrl: string | null; accent: string };
  t: Tradutor;
}) {
  const { janela, resumo, perda, medidas } = metricas;
  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background" style={{ borderTop: `3px solid ${marca.accent}` }}>
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-6 py-4">
          {marca.logoUrl ? (
            // `next/image` puxa o otimizador para a tela mais simples do
            // produto e exige o host na lista; aqui o logo é um endereço só.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={marca.logoUrl} alt="" className="h-8 w-auto" />
          ) : null}
          <p className="text-sm font-medium">{marca.nome}</p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl space-y-8 px-6 py-10">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{titulo}</h1>
          <p className="text-sm text-muted-foreground">
            {`${t("Números agregados dos últimos")} ${janela.dias} ${t("dias")}`}
          </p>
        </div>

        <section
          aria-label={t("Resumo do período")}
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Cartao rotulo={t("Conversas")} valor={numero.format(resumo.conversas)} />
          <Cartao rotulo={t("Negócios ganhos")} valor={numero.format(resumo.negocios_ganhos)} />
          <Cartao rotulo={t("Negócios perdidos")} valor={numero.format(resumo.negocios_perdidos)} />
          <Cartao
            rotulo={t("Conversão")}
            valor={formatarMedida({
              chave: "taxa_de_conversao",
              rotulo: t("Conversão"),
              valor: resumo.taxa_de_conversao,
              unidade: "razao",
            })}
            nota={`${numero.format(resumo.negocios_ganhos)} ${t("de")} ${numero.format(resumo.negocios_encerrados)} ${t("negócios encerrados")}`}
          />
        </section>

        {medidas.length === 0 ? (
          <section aria-label={t("Atendimento")} className="rounded-lg border bg-background p-6">
            <h2 className="text-sm font-semibold">{t("Atendimento")}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("Este painel ainda não tem medições de atendimento no período.")}
            </p>
          </section>
        ) : (
          medidas.map((medida) => (
            <section
              key={medida.chave}
              aria-label={medida.titulo}
              className="rounded-lg border bg-background p-6"
            >
              <h2 className="text-sm font-semibold">{medida.titulo}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{medida.eficiencia.rotulo}</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">
                {formatarMedida(medida.eficiencia)}
              </p>
              <ul className="mt-4">
                {medida.danos.map((dano) => (
                  <LinhaDeMedida key={dano.chave} medida={dano} />
                ))}
              </ul>
            </section>
          ))
        )}

        <section aria-label={t("Perdas")} className="rounded-lg border bg-background p-6">
          <h2 className="text-sm font-semibold">{t("Onde os negócios foram perdidos")}</h2>
          {perda.por_categoria.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t("Nenhuma perda registrada no período.")}
            </p>
          ) : (
            <ul className="mt-3">
              {perda.por_categoria.map((categoria) => (
                <li
                  key={categoria.chave}
                  className="flex items-baseline justify-between gap-4 border-t py-2 text-sm"
                >
                  <span>{categoria.chave}</span>
                  <span className="tabular-nums">{numero.format(categoria.quantidade)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            {`${numero.format(perda.total)} ${t("perdas no período.")}`}
            {perda.categorias_truncadas ? ` ${t("Exibindo as maiores.")}` : ""}
          </p>
        </section>
      </main>
    </div>
  );
}
