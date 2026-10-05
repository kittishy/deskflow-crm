-- ============================================================================
-- 0554: PREFERÊNCIAS DE VOZ DO AGENTE
-- manifest: resposta em áudio (TTS) vira opt-in por agente (tts_enabled/provider/voice_id em ai_agents, CHECK fish|elevenlabs).
--
-- A resposta em áudio (TTS) é opt-in por agente: `tts_enabled` liga, e o
-- provedor/voz dizem COM QUE voz. Sem esta linha o agente responde em TEXTO —
-- que é o comportamento de sempre e o que toda instalação existente já tem.
--
-- ## Por que coluna, e não jsonb
--
-- O resto dos limites do atendimento vive em colunas tipadas (`max_steps`,
-- `token_budget`, `history_message_window`, `inbound_debounce_ms` da 0498), e o
-- CHECK abaixo é a cerca que o TypeScript sozinho não garante: `tts_provider`
-- é texto que vem da tela, e `tts_enabled` é a alavanca de emergencia — um valor
-- fora da tabela tem de ser recusado pelo BANCO, não apenas pelo leitor.
--
-- ## Procedência (nada foi inventado)
--
-- Os dois provedores e a forma da chamada foram medidos na doc oficial em
-- 2026-10-02, não de memória:
--
--   - Fish Audio: `POST {TTS_BASE_URL}/v1/tts`, `Authorization: Bearer`,
--     header `model`, corpo `{ text, reference_id, format }`, resposta
--     `{ "audio": "<base64>" }`. A doc descreve `reference_id` como "voice
--     model ID" — é por isso que o campo se chama `tts_voice_id` aqui.
--   - ElevenLabs: `POST {TTS_BASE_URL}/v1/text-to-speech/{voice_id}`,
--     header `xi-api-key`, resposta em binário cru.
--
-- O CHECK lista só esses dois porque são os que `lib/audio/provedores/` tem.
-- Provedor fora da tabela não vira chamada: a resposta degrada para texto
-- (`provedor_desconhecido`).
--
-- ## Onde o áudio resultante fica
--
-- `whatsapp-media/<org>/<conversa>/tts-<assinatura>.<ext>` — o arquivo é
-- derivado da CONVERSA, então a conversa o possui: a inbox mostra, a LGPD apaga
-- junto com a conversa (mesmo regime da foto do catálogo, 0390). Nenhuma cópia
-- fora da pasta da conversa, e o canal recebe o caminho, nunca bytes.
--
-- Idempotente e reaplicável: `add column if not exists` e `drop constraint if
-- exists` antes do `add`. `update.sh` de quem já aplicou roda o apêndice do
-- baseline de novo, e `add constraint` sem guarda quebraria com 'already
-- exists'. Sem backfill: NULL é o estado de sempre (texto), então nenhuma linha
-- existente muda de comportamento — regressão zero.
-- ============================================================================

alter table public.ai_agents
  add column if not exists tts_enabled boolean not null default false;

alter table public.ai_agents
  add column if not exists tts_provider text;

alter table public.ai_agents
  add column if not exists tts_voice_id text;

comment on column public.ai_agents.tts_enabled is
  'Resposta em áudio (TTS) ligado para ESTE agente. false/NULL = responde em texto, que é o comportamento de sempre; exige TTS_API_KEY na instalação.';

comment on column public.ai_agents.tts_provider is
  'Provedor de voz escolhido na tela: fish | elevenlabs. NULL = usa o que o gancho do turno resolver; valor fora da tabela é recusado pelo banco e o turno degrada para texto.';

comment on column public.ai_agents.tts_voice_id is
  'Voz escolhida na tela para este agente (id do modelo de voz no provedor). NULL = usa TTS_VOICE_ID da instalação; vazio nos dois lados significa "sem voz" e o turno responde em texto.';

alter table public.ai_agents
  drop constraint if exists ai_agents_tts_provider_check;

alter table public.ai_agents
  add constraint ai_agents_tts_provider_check
  check (tts_provider is null or tts_provider in ('fish', 'elevenlabs'));
