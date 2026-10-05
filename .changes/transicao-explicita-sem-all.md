---
impacto: nada_mudou
secao: corrigido
titulo: Animações passam a listar a propriedade em vez de animar tudo
---
Sete pontos da interface usavam `transition-all`, que anima largura e altura junto e tira o controle de quais propriedades transicionam. Barras de progresso animam só a largura e controles, só as cores. Nada muda no comportamento visível; não é preciso fazer nada na instalação.
