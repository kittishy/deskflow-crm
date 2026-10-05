-- ============================================================================
-- 0562: CATÁLOGO DA GROQ
--
-- A Groq é OpenAI-compatível: entra pelo vocabulário aberto de `provider` da
-- 0127 e pela mesma fábrica `@ai-sdk/openai` com base URL própria e `.chat()`,
-- sem SDK novo — o mesmo caminho da DeepSeek (0342) e da Requesty (0410).
-- É o provedor das verificações auxiliares do agente de mineração de leads:
-- chave gratuita no painel deles, latência baixa, ideal para checagens que não
-- precisam do modelo principal.
--
-- ## Procedência dos ids e dos preços (NÃO foram inventados)
--
--   https://console.groq.com/docs/models (tabela de Production/Preview) e
--   https://console.groq.com/docs/model/qwen/qwen3.8-27b (página do modelo),
--   lidas em 2026-10-02. Preço em dólares POR MILHÃO de tokens, convertido
--   para CENTAVOS por milhão (arredondando para cima, como o catálogo manda):
--
--     qwen/qwen3.8-27b      0,80 / 4,00 US$/1M  →   80 /  400
--     openai/gpt-oss-120b   0,15 / 0,60 US$/1M  →   15 /   60
--     openai/gpt-oss-20b    0,075 / 0,30 US$/1M →    8 /   30
--
-- `supports_tools` entra ligado nos três: a página do Qwen lista Tool Use
-- entre as capabilities, e os GPT-OSS são modelos agentes com tool calling.
-- `supports_vision` só no Qwen (a página dele lista Vision, até 3 imagens);
-- nos GPT-OSS não há visão documentada, então fica desligado em vez de
-- afirmar o que não foi medido.
--
-- ATENÇÃO — o Qwen 3.8 27B está com selo Preview na doc da Groq (modelos
-- preview "podem ser descontinuados com pouco aviso"). Entra mesmo assim
-- porque é o modelo pedido para a mineração; se a Groq o aposentar, o sync
-- marca `deprecated_at` e a escolha recai no mais barato com ferramentas
-- (`escolherModeloDoProvedor`), como nos outros provedores.
--
-- Sem `is_default_for_provider`: o padrão por provedor é curadoria dos três
-- semeadores originais. Esta migration não insere em `ai_pricing`, mas a
-- linha aparece mesmo assim: o backfill 0113 do `baseline.sql` a deriva de
-- `ai_models` na próxima reaplicação.
--
-- Idempotente: `on conflict do update`. Sem coluna nova, sem função, sem
-- backfill de dado existente.
-- ============================================================================

insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, supports_vision)
values
  ('groq', 'qwen/qwen3.8-27b', 'Qwen 3.8 27B (Groq)',
   'Raciocínio e tool calling de fronteira num modelo denso, com latência muito baixa. Enxerga imagem (até 3 por chamada).',
   131072, 80, 400, true, true),
  ('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)',
   'Modelo aberto de 120B, barato e rápido para atendimento de volume.',
   131072, 15, 60, true, false),
  ('groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B (Groq)',
   'O menor e mais barato do catálogo, para classificações e checagens.',
   131072, 8, 30, true, false)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  supports_vision = excluded.supports_vision;
