/**
 * A ESCOLHA DO PROVEDOR e a chamada com contenção de rede.
 *
 * Duas decisões moram aqui, e as duas são de política, não de HTTP:
 *
 * 1. **Provedor desconhecido não vira URL.** A organização escreve `tts_provider`
 *    na tela; o texto vem do banco e pode ser qualquer coisa. `provedorDeVoz`
 *    devolve `null` para o que o produto não conhece, e quem chama degrada para
 *    texto. Se este arquivo montasse a URL a partir do nome, um valor errado
 *    viraria chamada HTTP (no máximo recusada pela rede) — e o operador veria
 *    "deu ruim" em vez de "essa escolha não existe".
 *
 * 2. **A allowlist de egress nasce da base EM USO**, nunca de uma constante de
 *    código — a mesma doutrina de `edge/llm/count-tokens.ts` e de
 *    `edge/egress.ts` ("montada por org/config... nunca hardcoded"). A base é a
 *    que a instalação configurou (`TTS_BASE_URL`) ou, na ausência dela, a padrão
 *    do provedor escolhido. O que a allowlist compra aqui não é "qual provedor
 *    pode ser chamado" (isso é a coluna da organização): é a checagem de REDIRECIONAMENTO
 *    (F4-08 ressalva 5) e o veto a URL que não é URL nenhuma. Um 302 do provedor
 *    para `https://outro-host/` é barrado antes de o segundo fetch existir.
 */
import { allowlistedFetch, buildAllowlist } from '@/lib/agent-engine/edge/egress';

import { BASE_DO_ELEVENLABS, provedorElevenLabs } from './provedores/elevenlabs';
import { BASE_DO_FISH, provedorFish } from './provedores/fish';
import {
  baseEmUso,
  ErroDeSintese,
  type AudioSintetizado,
  type CredenciaisDeVoz,
  type Log,
  type ProvedorDeSintese,
  type ProvedorDeVoz,
} from './types';

export { BASE_DO_ELEVENLABS, BASE_DO_FISH };

/**
 * Grafia que o produto reconhece. Maiúscula e espaço não contam como diferença:
 * `TTS_PROVIDER` e a tela escrevem em caixa baixa, e um valor que o operador
 * digitou "Fish Audio" precisa RECUSAR com nome de erro, não 500.
 */
function normaliza(nome: string | undefined | null): ProvedorDeVoz | null {
  const limpo = (nome ?? '').trim().toLowerCase();
  if (limpo === 'fish') return 'fish';
  if (limpo === 'elevenlabs') return 'elevenlabs';
  return null;
}

/** O provedor pelo nome, ou `null` — nunca uma exceção, nunca uma URL montada. */
export function provedorDeVoz(nome: string | undefined | null): ProvedorDeSintese | null {
  switch (normaliza(nome)) {
    case 'fish':
      return provedorFish();
    case 'elevenlabs':
      return provedorElevenLabs();
    default:
      return null;
  }
}

/**
 * O nome é de um provedor que o produto conhece? Usado pelo gancho do turno para
 * recusar ANTES de qualquer fetch — uma organização que escolheu "openai" tem de
 * ver "essa escolha não existe", não um 404 de um host que ninguém mapeou.
 */
export function provedorConhecido(nome: string | undefined | null): boolean {
  return normaliza(nome) !== null;
}

export interface SintetizarFalaDeps {
  provider: ProvedorDeVoz;
  credenciais: CredenciaisDeVoz;
  log?: Log;
  /** fetch injetável (testes); default = fetch nativo. */
  fetchImpl?: typeof fetch;
}

/**
 * Texto → bytes de áudio, ou `ErroDeSintese` com código estável.
 *
 * A base é resolvida UMA vez aqui e o mesmo valor serve à URL e à allowlist:
 * resolvê-las em lugares diferentes autorizaria um host e chamaria outro.
 *
 * O erro NUNCA carrega a resposta do fornecedor: ela pode voltar repetindo o
 * texto que deu erro, e o operador leria a fala do cliente no log da VPS. O
 * que sobra é o status HTTP.
 */
export async function sintetizarFala(
  texto: string,
  deps: SintetizarFalaDeps,
): Promise<AudioSintetizado> {
  const provedor = provedorDeVoz(deps.provider);
  if (!provedor) throw new ErroDeSintese('provedor_desconhecido');
  const base = baseEmUso(provedor.basePadrao, deps.credenciais.baseUrl);
  const allowlist = buildAllowlist([base]);
  const audio = await provedor.sintetizar(texto, deps.credenciais, {
    base,
    buscar: (url, init) =>
      allowlistedFetch(url, init, {
        allowlist,
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
  });
  if (audio.bytes.length === 0) throw new ErroDeSintese('sintese_sem_audio');
  return audio;
}
