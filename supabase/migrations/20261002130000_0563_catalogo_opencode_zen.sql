-- ============================================================================
-- 0563: MODELOS GRATUITOS E SEM TREINAMENTO DO OPENCODE ZEN
--
-- O CRM só publica Space Bunny Free e LongCat 2.5 Preview Free. A documentação
-- do Zen declara ambos temporariamente gratuitos, com retenção zero e sem uso
-- para treinamento. Ambos não declaram suporte a tools no catálogo da API, por
-- isso ficam indisponíveis para agentes que precisam executar ações no CRM.
-- Muse Spark Contributor, Nemotron de trial e todos os modelos pagos ficam de
-- fora: os primeiros podem treinar com prompts ou não aceitam dados pessoais;
-- os pagos não passam pela catraca free-only da conta.
--
-- Fonte: https://opencode.ai/docs/en/zen/ e https://opencode.ai/zen/v1/models
-- Sem coluna nova; preços zero; nenhum modelo é escolhido como padrão.
-- ============================================================================

insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, supports_vision, metadata)
values
  ('opencode', 'space-bunny-free', 'Space Bunny Free (OpenCode)',
   'Contingência gratuita temporária, com retenção zero e sem treinamento. Não executa ferramentas do CRM.',
   null, 0, 0, false, false,
   '{"temporario": true, "retencao_zero": true, "treinamento": false}'::jsonb),
  ('opencode', 'longcat-2.5-preview-free', 'LongCat 2.5 Preview Free (OpenCode)',
   'Contingência gratuita temporária, com retenção zero e sem treinamento. Preview; não executa ferramentas do CRM.',
   null, 0, 0, false, false,
   '{"temporario": true, "retencao_zero": true, "treinamento": false, "preview": true}'::jsonb)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  supports_vision = excluded.supports_vision,
  metadata = excluded.metadata;
