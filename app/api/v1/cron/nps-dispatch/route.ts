/**
 * O DISPARO DA PESQUISA DE SATISFAÇÃO — a conversa que fechou vira uma pergunta.
 *
 * ## Por que um cron e não um evento
 *
 * O encerramento canônico é `fn_service_status(p_org, p_conversation, 'closed')`,
 * chamado por `app/api/v1/conversations/[id]/close/route.ts` e por
 * `conversations/_handler.ts`. Ele grava `conversations.service_closed_at` e
 * **não** emite nada em `event_log` — e é por isso que esta leitura é a
 * varredura: um evento disparado no fechamento carregaria o
 * `organization_id`/`contact_id`/`channel_session_id` no payload, e cada mudança
 * no formato desse payload viraria uma leitura antiga quebrada. A coluna não
 * muda de forma.
 *
 * ## ⚠️ A JANELA DE 24 H NÃO É NOSSA — o texto do cabeçalho manda ler
 *
 * Toda a janela está em `lib/nps/disparo.ts` e em `lib/channels/capabilities.ts`.
 * Aqui só entra a CAPACIDADE (`requiresTemplates`), nunca o nome do provedor:
 * fora da janela, nos canais que exigem modelo aprovado, a pesquisa SAI COM
 * MODELO ou não sai — e `sendTemplateForSession` (que mora em `lib/channels/`)
 * recusa o que não estiver aprovado na plataforma, com um erro que diz qual dos
 * quatro motivos foi.
 *
 * ## ⚠️ A ORDEM É: RECUSA PRIMEIRO, LINHA DEPOIS
 *
 * A linha `nps_responses` é a prova de que o convite saiu, e o índice único
 * `(organization_id, conversation_id)` é a rede contra duas perguntas na mesma
 * conversa. Por isso a linha é inserida ANTES do envio: se o envio falhar, ela é
 * apagada (ninguém recebeu o convite, e a próxima rodada pode tentar de novo);
 * se o envio der certo, ela é a única prova. O inverso — enviar e depois gravar
 * — deixa a janela da direita aberta entre as duas, e duas rodadas do cron
 * AAPARIAM nesse meio-tempo.
 *
 * ## ⚠️ O NÚMERO É DO DONO DA INSTALAÇÃO
 *
 * A pesquisa é mensagem para cliente: passa pelo pacing do canal (`decide`), conta
 * no ledger depois de sair (`registraEnvio`) e nunca sai de organização parada.
 * Um envio que não passa por aqui é um número banido levando junto o atendimento
 * inteiro daquela empresa.
 *
 * ## ⚠️ AUDITORIA SÓ QUANDO HOUVE ENVIO
 *
 * `tests/unit/cron-audita-so-quando-ha-efeito.test.ts` varre o AST de TODA rota
 * deste diretório: `audit()` fora de condição, numa rodada de minutos, vira
 * dezenas de milhares de linhas por mês numa instalação que não atende ninguém.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { ehOperante } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

import {
  COOLDOWN_POR_CONTATO_MS,
  PRAZO_MAXIMO_APOS_FECHAR_MS,
  criarLinkDaPesquisa,
  configDoNps,
  decideDisparo,
  textoDaPesquisa,
} from "@/lib/nps/disparo";

export const dynamic = "force-dynamic";

/**
 * Quantas perguntas uma organização recebe por rodada.
 *
 * Sem teto, uma instalação que voltou de uma queda de três dias manda a pesquisa
 * de toda a fila velha de uma vez — e o dia inteiro de quem a recebe vira
 * convite. Quem não couber volta na próxima rodada: a elegibilidade é da
 * conversa, não desta passagem.
 */
export const TETO_POR_ORGANIZACAO = 50;

/** Quantas organizações uma rodada atende. Uma instalação com 500 não trava o cron. */
const TETO_DE_ORGANIZACOES = 200;

/** O PostgREST monta o `in` dentro da URL, e URL tem fim. */
const TAMANHO_DO_LOTE = 100;

interface ResultadoDoDisparo {
  organizacoes_com_pesquisa: number;
  conversas_examinadas: number;
  disparadas: number;
  /** Por que cada uma NÃO saiu. A chave `enviado` é o número de envios. */
  motivos: Record<string, number>;
}

type Linhas = Record<string, unknown>;

function lotes<T>(itens: readonly T[], tamanho = TAMANHO_DO_LOTE): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" ? valor : null;
}

async function rodar(
  admin: ReturnType<typeof createAdminClient>,
  requestId: string,
): Promise<ResultadoDoDisparo> {
  const agora = new Date();
  const motivos: Record<string, number> = {};
  const marcar = (motivo: string) => {
    motivos[motivo] = (motivos[motivo] ?? 0) + 1;
  };

  // A RÉGUA primeiro: organização parada não gasta nem fala
  // (`lib/organizacao/operante.ts`). Filtrar por aqui e não no fim é o que
  // impede que a rodada faça trabalho e-discovery que o dono da conta não pode
  // pagar.
  const { data: orgs, error: erroOrgs } = await admin
    .from("organizations")
    .select("id, status, settings");

  if (erroOrgs) throw new Error(`query_orgs_failed: ${erroOrgs.message}`);

  const comPesquisa = (orgs ?? [])
    .filter((linha) => ehOperante((linha as { status?: string | null }).status))
    .map((linha) => ({ id: String(linha.id), ...configDoNps((linha as Linhas).settings) }))
    .filter((org) => org.ligado)
    .slice(0, TETO_DE_ORGANIZACOES);

  const resultado: ResultadoDoDisparo = {
    organizacoes_com_pesquisa: comPesquisa.length,
    conversas_examinadas: 0,
    disparadas: 0,
    motivos,
  };
  if (comPesquisa.length === 0) return resultado;

  // O transporte e o pacing moram em `lib/channels/` e no motor; o import é
  // TARDIO pelo mesmo motivo do aviso de caso: quem agenda o handler não deve
  // pagar o bundle dos adapters para registrar um handler.
  const { capabilitiesOf, getAdapter, resolveSessionRef, CHANNEL_SESSION_REF_COLUMNS } =
    await import("@/lib/channels");
  const { sendTemplateForSession } = await import("@/lib/channels/meta/send-template-for-session");
  const { criarPacingDoCanal } = await import("@/lib/agent-engine/pacing/ledger-supabase");

  const urlPublica = env.NEXT_PUBLIC_APP_URL || null;
  const desdeFechamento = new Date(agora.getTime() - PRAZO_MAXIMO_APOS_FECHAR_MS).toISOString();
  const desdeCooldown = new Date(agora.getTime() - COOLDOWN_POR_CONTATO_MS).toISOString();

  for (const org of comPesquisa) {
    // ⚠️ `status = 'closed'` JUNTO com `service_closed_at`: `fn_service_status`
    // NÃO limpa `service_closed_at` ao reabrir (a linha 19408 do baseline só o
    // escreve quando o novo estado é terminal). Sem o filtro de status, uma
    // conversa REABERTA — atendimento retomado — receberia a pergunta sobre um
    // serviço que já voltou a acontecer.
    const { data: conversas, error: erroConversas } = await admin
      .from("conversations")
      .select("id, contact_id, is_group, last_inbound_at, service_closed_at, channel_session_id")
      .eq("organization_id", org.id)
      .eq("status", "closed")
      .not("service_closed_at", "is", null)
      .gte("service_closed_at", desdeFechamento)
      .order("service_closed_at", { ascending: true })
      .limit(TETO_POR_ORGANIZACAO);

    if (erroConversas) {
      logger.error("[nps-dispatch] consulta de conversas falhou", {
        error: erroConversas.message,
        organization_id: org.id,
        requestId,
      });
      marcar("consulta_falhou");
      continue;
    }
    if (!conversas?.length) continue;
    resultado.conversas_examinadas += conversas.length;

    const idsConversas = conversas.map((c) => String(c.id));
    const idsContatos = [...new Set(conversas.map((c) => String(c.contact_id)).filter(Boolean))];
    const idsSessoes = [
      ...new Set(conversas.map((c) => String(c.channel_session_id)).filter(Boolean)),
    ];

    const contatos = new Map<string, Linhas>();
    for (const lote of lotes(idsContatos)) {
      const { data } = await admin
        .from("contacts")
        .select("id, phone_number, is_blocked, is_anonymized, wa_identity, wa_lid")
        .eq("organization_id", org.id)
        .in("id", lote);
      for (const linha of data ?? []) contatos.set(String(linha.id), linha as Linhas);
    }

    const sessoes = new Map<string, Linhas>();
    for (const lote of lotes(idsSessoes)) {
      const { data } = await admin
        .from("channel_sessions")
        .select(`id, status, archived_at, ${CHANNEL_SESSION_REF_COLUMNS}`)
        .eq("organization_id", org.id)
        .in("id", lote);
      for (const linha of data ?? []) sessoes.set(String(linha.id), linha as Linhas);
    }

    // ⚠️ `organization_id` filtrado À MÃO em toda query: o client é o de service
    // role, que BYPASSA a RLS. A organização vem da lista de `organizations`,
    // nunca do corpo de nada.
    const jaPerguntadas = new Map<string, string>();
    const ultimoDoContato = new Map<string, string>();
    for (const lote of lotes(idsConversas)) {
      const { data: porConversa } = await admin
        .from("nps_responses")
        .select("conversation_id, asked_at")
        .eq("organization_id", org.id)
        .in("conversation_id", lote);
      for (const linha of porConversa ?? []) {
        jaPerguntadas.set(String(linha.conversation_id), String(linha.asked_at));
      }
    }
    for (const lote of lotes(idsContatos)) {
      const { data: porContato } = await admin
        .from("nps_responses")
        .select("contact_id, asked_at")
        .eq("organization_id", org.id)
        .in("contact_id", lote)
        .gte("asked_at", desdeCooldown);
      for (const linha of porContato ?? []) {
        const contato = String(linha.contact_id);
        const quando = String(linha.asked_at);
        const atual = ultimoDoContato.get(contato);
        if (!atual || quando > atual) ultimoDoContato.set(contato, quando);
      }
    }

    const pacing = await criarPacingDoCanal(admin);

    for (const linha of conversas) {
      const conversa = linha as Linhas;
      const contato = contatos.get(String(conversa.contact_id));
      const sessao = sessoes.get(String(conversa.channel_session_id));
      const provider = texto(sessao?.provider);

      let exigeModeloForaDaJanela = false;
      if (sessao && provider) {
        try {
          exigeModeloForaDaJanela = capabilitiesOf(provider as never).requiresTemplates;
        } catch {
          // Provider fora da matriz: `capabilitiesOf` falha fechado, e o
          // `getAdapter` daqui embaixo lançaria pelo MESMO motivo. Sair agora é
          // o mesmo desfecho, sem derrubar a rodada inteira: uma sessão com
          // provider desconhecido não pode impedir a pesquisa das outras.
          marcar("canal_desconhecido");
          continue;
        }
      } else {
        marcar("sem_canal");
        continue;
      }

      const decisao = decideDisparo({
        agora,
        ligado: org.ligado,
        fechadoEm: texto(conversa.service_closed_at),
        ultimoInboundEm: texto(conversa.last_inbound_at),
        telefone: texto(contato?.phone_number),
        optOut:
          (contato?.is_blocked as boolean | undefined) === true ||
          (contato?.is_anonymized as boolean | undefined) === true,
        isGroup: (conversa.is_group as boolean | undefined) === true,
        urlPublica,
        exigeModeloForaDaJanela,
        modeloAprovado: org.modelo?.nome ?? null,
        perguntadoEm: jaPerguntadas.get(String(conversa.id)) ?? null,
        ultimoContatoPerguntadoEm: ultimoDoContato.get(String(conversa.contact_id)) ?? null,
      });

      if (!decisao.dispara) {
        marcar(decisao.motivo);
        continue;
      }

      const canal = getAdapter(provider as never);
      if (!canal.isConfigured()) {
        marcar("canal_sem_credencial");
        continue;
      }
      const sessaoArquivada =
        texto(sessao?.archived_at) !== null || texto(sessao?.status) === "archived";
      if (sessaoArquivada) {
        marcar("canal_arquivado");
        continue;
      }

      // O NÚMERO primeiro: o pacing decide espaçamento e teto diário, e nenhuma
      // pergunta entra sem ele.
      const liberacao = await pacing.decide(org.id, String(conversa.channel_session_id), agora);
      if (!liberacao.liberado) {
        marcar(liberacao.motivo === "teto_diario" ? "teto_diario" : "espacamento");
        continue;
      }

      // A LINHA antes do envio: `ver o cabeçalho` — a prova da pergunta feita é a
      // linha, e o índice único fecha a corrida entre duas rodadas.
      const token = randomUUID();
      const { data: criada, error: erroLinha } = await admin
        .from("nps_responses")
        .insert({
          organization_id: org.id,
          conversation_id: String(conversa.id),
          contact_id: String(conversa.contact_id),
          token,
          asked_at: agora.toISOString(),
        })
        .select("id")
        .maybeSingle();

      if (erroLinha || !criada) {
        // 23505 = outra rodada (ou outra instância) já perguntou nesta conversa.
        marcar(erroLinha?.code === "23505" ? "corrida_ja_perguntou" : "gravacao_falhou");
        continue;
      }

      const link = urlPublica ? criarLinkDaPesquisa(urlPublica, token) : null;
      const destino = link
        ? canal.resolveRecipient({
            isGroup: false,
            groupChatId: null,
            phoneNumber: texto(contato?.phone_number),
            // A identidade que o CONTATO carrega, e não o telefone cru: contato
            // que só tem identidade de conversa (`wa_lid`) não tem telefone para
            // endereçar, e `resolveRecipient` devolve `null` — o convite sairia
            // para o número errado ou para nenhum.
            waIdentity: texto(contato?.wa_identity),
            waLid: texto(contato?.wa_lid),
          })
        : null;

      try {
        if (!link || !destino) throw new Error("destino_indisponivel");

        if (decisao.viaModelo && org.modelo) {
          // Fora da janela, o que sai é o MODELO aprovado, com o link no slot
          // que a tela de modelos declara. Se ele não estiver aprovado na
          // plataforma, `sendTemplateForSession` lança nomeando o motivo — e a
          // linha criada acima é desfeita, porque nada saiu.
          // O `external_id` do convite não mora em `messages`: isto não é mensagem do
          // atendimento, é convite anônimo — a linha criada acima é a prova de
          // que saiu, e a `asked_at` já responde "quando".
          await sendTemplateForSession(admin, {
            organizationId: org.id,
            sessionRef: resolveSessionRef(sessao as never),
            to: destino,
            name: org.modelo.nome,
            language: org.modelo.idioma,
            values: { link },
            channelSessionId: String(conversa.channel_session_id),
          });
        } else {
          await canal.send({
            organizationId: org.id,
            sessionRef: resolveSessionRef(sessao as never),
            to: destino,
            kind: "text",
            body: textoDaPesquisa(link),
          });
        }
      } catch (erro) {
        const detalhe = erro instanceof Error ? erro.message : String(erro);
        logger.warn("[nps-dispatch] convite não saiu; linha desfeita", {
          error: detalhe,
          conversation_id: String(conversa.id),
          organization_id: org.id,
          requestId,
        });
        await admin
          .from("nps_responses")
          .delete()
          .eq("id", criada.id)
          .eq("organization_id", org.id);
        marcar(decisao.viaModelo ? "modelo_rejeitado" : "envio_falhou");
        continue;
      }

      await pacing.registraEnvio(org.id, String(conversa.channel_session_id), agora);
      resultado.disparadas++;
      marcar(decisao.motivo);
    }
  }

  return resultado;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resultado: ResultadoDoDisparo;
  try {
    resultado = await rodar(createAdminClient(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[nps-dispatch] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to dispatch the satisfaction survey.", 500, {
      requestId,
    });
  }

  // Efeito, não passagem: só houve ENVIO quando alguém recebeu o convite. A
  // rodada que examinou e recusou não é registrada — ver o cabeçalho.
  if (resultado.disparadas > 0) {
    void audit({
      action: "nps.pesquisa_dispensada",
      resourceType: "conversation",
      bypassedRls: true,
      metadata: resultado as unknown as Record<string, unknown>,
      requestId,
    });
  }

  return ok(resultado, { requestId });
}

export const GET = handle;
export const POST = handle;
