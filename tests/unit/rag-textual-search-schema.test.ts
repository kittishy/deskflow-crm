import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261002091500_0503_busca_textual_free_only.sql", "utf8");
const baseline = readFileSync("supabase/baseline.sql", "utf8");

describe("RPC de busca textual free-only", () => {
  it("vincula consulta lexical ao tenant, às fontes ativas e à versão ativa", () => {
    for (const source of [migration, baseline]) {
      expect(source).toContain("fn_buscar_trechos_textuais_das_fontes");
      expect(source).toContain("c.organization_id = p_organization_id");
      expect(source).toContain("s.id = any(p_source_ids)");
      expect(source).toContain("s.is_active");
      expect(source).toContain("s.status = 'ready'");
      expect(source).toContain("c.kb_version_id = s.active_kb_version_id");
      expect(source).toContain("current_setting('role', true)");
      expect(source).toContain("<> 'service_role'");
      expect(source).toContain("to_tsvector('portuguese', c.content)");
      expect(source).toContain("from public, anon");
    }
  });
});
