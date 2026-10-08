import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

// Exceções temporárias, com motivo escrito: arquivo que ainda importa
// lucide-react porque migrá-lo agora colidiria com trabalho em voo. A lista
// só encolhe — hoje está zerada (dialog.tsx e ChaveDeConhecimento.tsx foram
// migrados na mesma linha do fork, sem reconciliação pendente).
const ALLOWLIST: string[] = [];

const DIRETORIOS = ["app", "components", "lib", "hooks", "workers", "scripts"];

function arquivosTs(dir: string): string[] {
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
      } else if (/\.(ts|tsx)$/.test(entrada.name) && !/[.](test|spec)[.]/.test(entrada.name)) {
        achados.push(cheio);
      }
    }
  }
  return achados;
}

function importaLucide(arquivo: string): boolean {
  const conteudo = fs.readFileSync(arquivo, "utf8");
  return /from\s+["']lucide-react["']/.test(conteudo);
}

describe("iconografia sem lucide-react", () => {
  it("nenhum arquivo de produto importa lucide-react fora da allowlist", () => {
    // POR QUE ESTE TESTE EXISTE: docs/design-system/09-anti-patterns.md §7
    // proíbe Lucide ("~80% dos shadcn-based usam Lucide. Genérico por
    // convergência") e 05-iconography-phosphor.md + lib/ui/icons.ts (ADR-05)
    // mandam Phosphor via o mapa canônico. Sem a cerca, cada `npx shadcn add`
    // futuro reintroduz o import em silêncio — como aconteceu nos 4 primitivos
    // de components/ui.
    const infratores = DIRETORIOS.flatMap(arquivosTs)
      .map((cheio) => path.relative(RAIZ, cheio).replace(/\\/g, "/"))
      .filter((rel) => !ALLOWLIST.includes(rel))
      .filter((rel) => importaLucide(path.join(RAIZ, rel)));
    expect(infratores).toEqual([]);
  });

  it("a allowlist só encolhe e continua apontando para dívida real", () => {
    for (const rel of ALLOWLIST) {
      const cheio = path.join(RAIZ, rel);
      expect(fs.existsSync(cheio), `${rel} sumiu do disco — remova da ALLOWLIST`).toBe(true);
      expect(importaLucide(cheio), `${rel} já foi migrado — remova da ALLOWLIST`).toBe(true);
    }
  });
});
