/**
 * Contrato da SÍNTESE DE VOZ (o caminho de saída do áudio do agente).
 *
 * O caminho de ENTRADA já existe e é outro: `lib/messaging/media/transcription.ts`
 * (STT, áudio do cliente → texto). Aqui é o inverso — o texto que o agente
 * escreveu → áudio que o cliente ouve. Os dois lados são independentes: um
 * agente pode transcrever sem ter voz, e ter voz sem transcrever.
 *
 * O áudio NÃO vai ao canal como bytes nem como URL: o provedor devolve os
 * bytes, `guardar.ts` os põe em `whatsapp-media/<org>/<conversa>/`, e quem
 * assina a URL curta é o handler de mensagens — como em toda mídia. O
 * contêiner que o canal exige (OGG/OPUS) é problema do adapter do canal,
 * que já pede conversão (`convert: true`).
 */

/** Provedores que o produto conhece. Grafia fora daqui = degrada, não chama URL nenhuma. */
export type ProvedorDeVoz = 'fish' | 'elevenlabs';

export interface CredenciaisDeVoz {
  /** Chave do serviço. Vai SÓ no header — nunca na URL, nunca em log. */
  apiKey: string;
  /** Endereço do serviço; vazio = base padrão do provedor. */
  baseUrl?: string;
  /** Modelo do provedor (Fish: `s2.1-pro-free`; ElevenLabs: `eleven_flash_v2_5`). */
  model?: string;
  /** A voz. Vazio = não há o que sintetizar (ambos os provedores exigem uma). */
  voiceId?: string;
}

/**
 * O que o provedor DEVOLVEU — não o que o WhatsApp quer.
 *
 * `mime`/`extensao` descrevem os bytes com honestidade (nada de chamar mp3 de
 * ogg): a conversão para o formato que o canal exige é do adapter
 * (`convert: true`), que abre o arquivo e remixa. Declarar um tipo que os
 * bytes não têm faria o probe falhar no lugar errado.
 */
export interface AudioSintetizado {
  bytes: Uint8Array;
  mime: string;
  extensao: string;
}

/** Só o que a camada de cima precisa; como a rede, a base e o log entram é de quem chama. */
export interface ProvedorDeSintese {
  readonly nome: ProvedorDeVoz;
  /**
   * Base SEM barra final, usada quando a instalação não declara uma.
   *
   * É valor de DADO, não de configuração: a base que vale na chamada é resolvida
   * uma vez por `sintese.ts` (`.env` > padrão) e chega em `deps.base`. Se cada
   * provedor guardasse a própria base no fechamento, a allowlist de egress e a
   * URL buscada seriam resolvidas em lugares diferentes — e o host allowlistado
   * deixaria de ser o host chamado, que é exatamente o bypass que a allowlist
   * existe para fechar.
   */
  readonly basePadrao: string;
  sintetizar(
    texto: string,
    credenciais: CredenciaisDeVoz,
    deps: { base: string; buscar: (url: string, init: RequestInit) => Promise<Response> },
  ): Promise<AudioSintetizado>;
}

/**
 * `Log` é o logger do runtime (`agent-engine/obs/logger`), declarado aqui como
 * estrutura para `lib/audio` não depender do runtime — e por isso `lib/audio`
 * continua testável sem dublê de módulo. Tem a MESMA forma de `Logger`, então
 * o logger do worker entra sem adaptador.
 *
 * Regra dura nº 8: quem chama passa por aqui SÓ host e código — nunca a chave,
 * o texto do cliente, nem a URL com querystring.
 */
export interface Log {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Base efetiva desta chamada: a do `.env` se houver, senão a padrão do
 * provedor. Sem barra final e com `/v1` removido de quem traz (o provedor decide
 * onde a versão mora — Fish tem `/v1/tts`, ElevenLabs tem `/v1/text-to-speech`).
 *
 * Esta é a ÚNICA resolução de base do produto: `sintetise.ts` chama uma vez, e
 * o mesmo valor vai para a URL e para a allowlist de egress.
 */
export function baseEmUso(basePadrao: string, configurada: string | undefined): string {
  const bruta = (configurada ?? '').trim().replace(/\/+$/, '');
  return bruta === '' ? basePadrao : bruta.replace(/\/v1$/, '');
}

/** Erro de síntese com código estável e SEM texto do fornecedor (que pode trazer PII). */
export class ErroDeSintese extends Error {
  override readonly name = 'sintese_falhou';
  readonly codigo: string;
  constructor(codigo: string) {
    super(codigo);
    this.codigo = codigo;
  }
}
