import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

const DIRETORIOS = ["app", "components", "lib", "hooks", "workers", "scripts"];

function arquivosFonte(dir: string): string[] {
  const base = path.join(RAIZ, dir);
  if (!fs.existsSync(base)) return [];
  const achados: string[] = [];
  const pilha = [base];
  while (pilha.length > 0) {
    const atual = pilha.pop() as string;
    for (const entrada of fs.readdirSync(atual, { withFileTypes: true })) {
      const cheio = path.join(atual, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name !== "node_modules") pilha.push(cheio);
      } else if (/\.(tsx?|css)$/.test(entrada.name) && !/[.](test|spec)[.]/.test(entrada.name)) {
        achados.push(cheio);
      }
    }
  }
  return achados;
}

describe("motion sem transition-all", () => {
  it("nenhum arquivo de produto anima 'all' em vez de listar as props", () => {
    // POR QUE ESTE TESTE EXISTE: docs/design-system/09-anti-patterns.md §23
    // proíbe `transition: all` — anima width/height (caras) e tira o controle
    // de quais props transicionam. O conserto é listar explicitamente
    // (`transition-colors`, `transition-[width]`, …), como manda
    // 07-motion-language.md. Sem a cerca, cada `npx shadcn add` futuro
    // reintroduz o `transition-all` do template em silêncio.
    const infratores = DIRETORIOS.flatMap(arquivosFonte)
      .map((cheio) => path.relative(RAIZ, cheio).replace(/\\/g, "/"))
      .filter((rel) => {
        const conteudo = fs.readFileSync(path.join(RAIZ, rel), "utf8");
        return (
          /(^|[\s"'`{])transition-all([\s"'`}])/.test(conteudo) ||
          /transition\s*:\s*all\b/.test(conteudo)
        );
      });
    expect(infratores).toEqual([]);
  });
});
