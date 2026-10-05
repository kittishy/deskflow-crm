---
impacto: nada_mudou
secao: adicionado
titulo: O fork passa a abrir PR semanal com as novidades do produto
---

Nada muda para quem opera a VPS. O repositório ganha um workflow (`sync-upstream`, segundas 06:00 UTC) que tenta mesclar a `main` do produto numa branch e abre um pull request quando o merge sai limpo — ou uma issue listando os arquivos em conflito quando não sai. Nenhum merge entra sozinho: todo sync passa por revisão humana e pelos gates antes de chegar à `main` do fork.
