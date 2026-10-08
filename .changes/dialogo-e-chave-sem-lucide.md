---
impacto: nada_mudou
secao: corrigido
titulo: Os dois últimos arquivos saem do Lucide e a cerca zera a allowlist
---
O diálogo base (`components/ui/dialog.tsx`, usado por todos os modais do produto) e o cartão da chave de embedding passam a usar o mapa canônico Phosphor. Com isso nenhum arquivo de produto importa mais `lucide-react`, e a allowlist da cerca fica vazia. Nada muda no comportamento; não é preciso fazer nada na instalação.
