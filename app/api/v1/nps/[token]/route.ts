/**
 * A PESQUISA DE SATISFAÇÃO — a página que o cliente abre no link do WhatsApp.
 *
 * ## Por que esta rota devolve HTML e não `ok()`
 *
 * Quem chega aqui é o NAVEGADOR do cliente final, no celular, sem sessão nossa
 * e sem cookie para carregar a tela. Um `{ data: … }` JSON seria uma tela em
 * branco. É a mesma exceção das rotas de captura de anúncio (`app/api/v1/anuncios/**`,
 * `app/api/v1/rastreio/[id]`): navegação de terceiro, resposta de terceiro.
 *
 * ## ⚠️ A ORGANIZAÇÃO NUNCA VEM DO CAMINHO
 *
 * O `organization_id` é lido da LINHA que o token identifica, e é a única
 * fonte. Um corpo ou uma query string com outra organização seria IDOR — o
 * convite valeria para a empresa errada. Mesma regra de `rastreio/[id]`.
 *
 * ## ⚠️ O TOKEN É A CREDENCIAL, E POR ISSO A ROTA PRECISA DE DUAS GUARDIAS
 *
 * 1. **Não há sessão nem cookie.** Quem tem o link responde. Por isso a rota
 *    precisa de uma entrada em `lib/auth/public-paths.ts` (declarada pelo
 *    dono deste pedaço, fora do escopo desta mudança) — sem ela o `proxy`
 *    responde 401 ANTES do handler, e a página nunca abre.
 * 2. **Rate limit por token e por IP.** `checkRateLimit`, a mesma dobradiça de
 *    `rastreio/[id]`: sem ela o link vira enumerador de palpites de nota.
 *
 * A linha nasce com `asked_at` e sem nota; responder é UPDATE idempotente —
 * quem clica duas vezes no "Enviar" não cria duas respostas, e a segunda vez vê
 * a página de "já respondemos".
 */
import { randomUUID } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { clientIp } from "@/lib/plataformas-de-anuncio/pagina-de-captura";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** A nota é um inteiro de 0 a 10 — o mesmo vocabulário do CHECK do banco. */
export const respostaSchema = z.object({
  score: z.coerce.number().int().min(0).max(10),
  comentario: z.string().trim().max(1000).optional(),
});

interface RouteCtx {
  params: Promise<{ token: string }>;
}

interface LinhaDoConvite {
  id: string;
  organization_id: string;
  conversation_id: string;
  asked_at: string;
  answered_at: string | null;
  score: number | null;
}

/**
 * HTML neutro de propósito: quem responde é cliente da empresa dona do CRM, e a
 * marca é DELA (`lib/branding/`). A página não carrega logo, não carrega fonte e
 * não promete nada além de "grava a nota" — promessa de prazo ou de retorno que
 * o produto não garante seria texto de mentira na tela de outra empresa.
 */
function pagina(titulo: string, corpo: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="referrer" content="no-referrer">` +
      `<title>${titulo}</title>` +
      `<style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1.5rem;` +
      `color:#18181b;background:#fff;line-height:1.5}main{max-width:34rem;margin:0 auto}` +
      `fieldset{border:0;padding:0;margin:0 0 1rem}legend{padding:0;font-weight:600}` +
      `button{min-height:44px;min-width:44px;border:1px solid #d4d4d8;border-radius:8px;` +
      `background:#fff;font-size:1rem;cursor:pointer}button[aria-pressed=true]{` +
      `background:#18181b;color:#fff;border-color:#18181b}` +
      `textarea{width:100%;min-height:6rem;padding:.5rem;border:1px solid #d4d4d8;` +
      `border-radius:8px;font:inherit}input[type=submit]{min-height:44px;padding:0 1.25rem;` +
      `border:0;border-radius:8px;background:#18181b;color:#fff;font:inherit;font-weight:600;` +
      `cursor:pointer}small{color:#52525b}</style></head><body><main>${corpo}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Página de uma credencial: sem cache no intermediary e sem o token
        // vazando para o próximo site por Referer.
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex",
      },
    },
  );
}

/**
 * O formulário. Um `<button type="submit" name="score">` por nota e NADA de
 * JavaScript: é o botão que submits o form, e o botão escolhido é o que vai.
 * Botão de nota dentro de `<a>` (o desenho que parece óbvio) obrigaria a
 *.preventDefault() para não navegar, e aí volta a depender de JS rodando no
 * celular do cliente.
 *
 * A nota viaja no corpo do formulário (`name="score"`), e não num botão com
 * `onclick`: quem envia é o MESMO formulário, para GET e POST lerem a mesma
 * linha.
 */
function formulario(token: string, comentario: string): string {
  const botoes = Array.from({ length: 11 }, (_, n) => n)
    .map(
      (n) =>
        `<button type="submit" name="score" value="${n}" ` +
        `aria-label="Nota ${n} de 10">${n}</button>`,
    )
    .join("");
  return (
    `<form method="post" action="/api/v1/nps/${token}">` +
    `<h1 style="font-size:1.25rem;margin:0 0 .5rem">Como foi seu atendimento?</h1>` +
    `<p style="margin:0 0 1rem">Escolha uma nota de <strong>0 a 10</strong>.</p>` +
    `<fieldset><legend>Nota</legend>` +
    `<div style="display:flex;flex-wrap:wrap;gap:.5rem">${botoes}</div></fieldset>` +
    `<p><label for="comentario">Comentário (opcional)</label><br>` +
    `<textarea id="comentario" name="comentario" maxlength="1000">${comentario}</textarea></p>` +
    `<input type="submit" value="Enviar">` +
    `</form>`
  );
}

function paginaDeObrigado(): string {
  return (
    `<h1 style="font-size:1.25rem;margin:0 0 .5rem">Obrigado pela resposta</h1>` +
    `<p style="margin:0">A nota foi registrada.</p>`
  );
}

function paginaDeJaRespondida(): string {
  return (
    `<h1 style="font-size:1.25rem;margin:0 0 .5rem">Esta resposta já foi registrada</h1>` +
    `<p style="margin:0">Cada convite vale por uma resposta. Se precisar falar com a equipe, ` +
    `responda aqui no WhatsApp.</p>`
  );
}

function paginaDeErro(mensagem: string): NextResponse {
  // 404 e não 200: link de convite quebrado é ausência de recurso, e responder
  // 200 faria o buscador de alguém indexar uma página de erro como conteúdo.
  return pagina("Pesquisa de satisfação", `<h1 style="font-size:1.25rem">${mensagem}</h1>`, 404);
}

/**
 * A linha do convite, ou `null`.
 *
 * O `service_role` BYPASSA a RLS — e é o que esta rota precisa: quem responde
 * não é membro da organização. A garantia de que ele não enxerga nada além da
 * própria linha vem do `select` restrito ao token, e do fato de a rota nunca
 * devolver `organization_id` ao cliente.
 */
async function carregar(token: string): Promise<LinhaDoConvite | null> {
  const { data, error } = await createAdminClient()
    .from("nps_responses")
    .select("id, organization_id, conversation_id, asked_at, answered_at, score")
    .eq("token", token)
    .maybeSingle();
  if (error) return null;
  return (data as LinhaDoConvite | null) ?? null;
}

/** Rate limit: por token E por IP. Quem tem um convite não fica com 30 respostas. */
async function excedeu(req: NextRequest, token: string): Promise<boolean> {
  const porToken = await checkRateLimit(`nps:token:${token}`, 10, 60);
  if (!porToken.allowed) return true;
  const ip = clientIp(req);
  if (ip && !(await checkRateLimit(`nps:ip:${ip}`, 30, 60)).allowed) return true;
  return false;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const token = z.uuid().safeParse((await ctx.params).token);
  if (!token.success) return paginaDeErro("Link de pesquisa inválido.");
  if (await excedeu(req, token.data)) {
    return new NextResponse(null, {
      status: 429,
      headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    });
  }

  const linha = await carregar(token.data);
  if (!linha) return paginaDeErro("Este link de pesquisa não existe mais.");
  if (linha.answered_at) return pagina("Pesquisa de satisfação", paginaDeJaRespondida());
  return pagina("Como foi seu atendimento?", formulario(token.data, ""));
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const token = z.uuid().safeParse((await ctx.params).token);
  if (!token.success) return paginaDeErro("Link de pesquisa inválido.");
  if (await excedeu(req, token.data)) {
    return new NextResponse(null, {
      status: 429,
      headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    });
  }

  // Zod na BORDADE: nota é inteiro de 0 a 10 e o comentário tem teto. O mesmo
  // teto do CHECK do banco — a validação de fora é UX (a página de erro), a de
  // dentro é garantia.
  const form = await req.formData().catch(() => null);
  const bruto = form
    ? { score: form.get("score"), comentario: form.get("comentario") ?? undefined }
    : await req.json().catch(() => null);
  const parsed = respostaSchema.safeParse(bruto);
  if (!parsed.success) {
    return pagina("Pesquisa de satisfação", formulario(token.data, ""));
  }

  const linha = await carregar(token.data);
  if (!linha) return paginaDeErro("Este link de pesquisa não existe mais.");
  if (linha.answered_at) return pagina("Pesquisa de satisfação", paginaDeJaRespondida());

  const { error } = await createAdminClient()
    .from("nps_responses")
    .update({
      score: parsed.data.score,
      comment: parsed.data.comentario ? parsed.data.comentario : null,
      answered_at: new Date().toISOString(),
    })
    .eq("id", linha.id)
    .eq("organization_id", linha.organization_id)
    // Só grava onde ainda NÃO há resposta: dois navegadores com o mesmo link
    // chegam juntos, e o segundo não pode sobrescrever a nota do primeiro.
    .is("answered_at", null)
    .select("id")
    .maybeSingle();

  if (error) return paginaDeErro("Não foi possível registrar agora. Tente de novo em instantes.");

  // Mutação, e a organização vem da LINHA (nunca do caminho). `bypassedRls`:
  // quem responde não é membro, e a trilha precisa dizer isso.
  void audit({
    action: "nps.pesquisa_respondida",
    organizationId: linha.organization_id,
    resourceType: "conversation",
    resourceId: linha.conversation_id,
    bypassedRls: true,
    metadata: { score: parsed.data.score, com_comentario: Boolean(parsed.data.comentario) },
    requestId,
  });

  return pagina("Obrigado", paginaDeObrigado());
}
