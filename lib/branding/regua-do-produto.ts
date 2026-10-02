/**
 * A régua do design system, congelada em módulo — a fonte da derivação em RUNTIME.
 *
 * POR QUE ESTE ARQUIVO EXISTE, e não um `readFileSync("app/globals.css")`:
 *
 * A imagem de produção é `output: "standalone"` (next.config.ts) e o Dockerfile
 * copia para o runner apenas `.next/standalone`, `.next/static` e `public/`. O
 * `app/globals.css` NÃO existe no contêiner que o self-hoster roda. Um
 * `readFileSync` no caminho de render do `app/layout.tsx` daria ENOENT — 500 em
 * todas as telas, na VPS de quem a feature existe para servir, e verde em dev,
 * em teste e na Vercel. É o mesmo modo de falha que `lib/branding.ts` documenta
 * para os `NEXT_PUBLIC_*`.
 *
 * A separação também é a certa conceitualmente: a RÉGUA é do produto e nasce
 * congelada no build; a COR é da instalação e só existe em runtime. Só a segunda
 * precisa ser lida do ambiente.
 *
 * ESTE ARQUIVO É GERADO. Não edite à mão: ele é o `extrairRegua()` aplicado ao
 * `app/globals.css`. `tests/unit/branding-regua-do-produto.test.ts` compara os
 * dois a cada run e imprime o literal novo na mensagem de falha — mexeu na
 * paleta, o teste reprova e entrega o texto para colar aqui.
 */

import type { Regua } from "./contraste";

export const REGUA_DO_PRODUTO: Regua = {
      rampaDoProduto: [
        "#fff2ee",
        "#ffe2da",
        "#ffc3b3",
        "#fc987e",
        "#f16f4d",
        "#dc4f2a",
        "#b83d1b",
        "#90341c",
        "#732d1b",
        "#5f281a",
        "#321109",
      ],
      claro: {
        nome: "claro",
        base: [
          {
            chave: "--color-bg",
            hex: "#faf9f6",
          },
          {
            chave: "--color-surface",
            hex: "#ffffff",
          },
          {
            chave: "--color-surface-elevated",
            hex: "#f3f0ea",
          },
        ],
        tingidas: [
          {
            chave: "--color-accent-soft",
            fonte: {
              tipo: "grau",
              indice: 1,
              alfa: 1,
            },
          },
        ],
        papeis: [
          {
            token: "--color-accent",
            tipo: "componente",
            fonte: {
              tipo: "grau",
              indice: 6,
              alfa: 1,
            },
            contra: null,
          },
          {
            token: "--color-accent-fg",
            tipo: "texto",
            fonte: {
              tipo: "frenteCalculada",
              sobre: {
                tipo: "grau",
                indice: 6,
                alfa: 1,
              },
            },
            contra: [
              {
                tipo: "grau",
                indice: 6,
                alfa: 1,
              },
            ],
          },
          {
            token: "--color-accent-hover",
            tipo: "componente",
            fonte: {
              tipo: "grau",
              indice: 7,
              alfa: 1,
            },
            contra: null,
          },
          {
            token: "--ring",
            tipo: "componente",
            fonte: {
              tipo: "grau",
              indice: 5,
              alfa: 1,
            },
            contra: null,
          },
          {
            token: "::selection/color",
            tipo: "texto",
            fonte: {
              tipo: "grau",
              indice: 10,
              alfa: 1,
            },
            contra: [
              {
                tipo: "grau",
                indice: 2,
                alfa: 1,
              },
            ],
          },
          {
            token: ":focus-visible/outline",
            tipo: "componente",
            fonte: {
              tipo: "grau",
              indice: 5,
              alfa: 1,
            },
            contra: null,
          },
        ],
        semanticas: [
          {
            nome: "success",
            hex: "#5f7a4a",
          },
          {
            nome: "warning",
            hex: "#9a6f22",
          },
          {
            nome: "error",
            hex: "#a33a52",
          },
          {
            nome: "info",
            hex: "#46758c",
          },
        ],
        neutros: [
          "#faf9f6",
          "#f3f0ea",
          "#e6e1d8",
          "#d2ccc0",
          "#a9a396",
          "#7c766b",
          "#5a554c",
          "#45413a",
          "#2b2823",
          "#1a1815",
          "#0e0d0b",
        ],
        indices: {
          accent: 6,
          hover: 7,
          soft: 1,
        },
        alfaDoSoft: 1,
      },
      escuro: {
        nome: "escuro",
        base: [
          {
            chave: "--color-bg",
            hex: "#0b0b0b",
          },
          {
            chave: "--color-surface",
            hex: "#111111",
          },
          {
            chave: "--color-surface-elevated",
            hex: "#161412",
          },
        ],
        tingidas: [
          {
            chave: "--color-accent-soft",
            fonte: {
              tipo: "literal",
              hex: "#f16f4d",
              alfa: 0.16,
            },
          },
        ],
        papeis: [
          {
            token: "--color-accent",
            tipo: "componente",
            fonte: {
              tipo: "grau",
              indice: 4,
              alfa: 1,
            },
            contra: null,
          },
          {
            token: "--color-accent-fg",
            tipo: "texto",
            fonte: {
              tipo: "frenteCalculada",
              sobre: {
                tipo: "grau",
                indice: 4,
                alfa: 1,
              },
            },
            contra: [
              {
                tipo: "grau",
                indice: 4,
                alfa: 1,
              },
            ],
          },
          {
            token: "--color-accent-hover",
            tipo: "componente",
            fonte: {
              tipo: "grau",
              indice: 3,
              alfa: 1,
            },
            contra: null,
          },
          {
            token: "--ring",
            tipo: "componente",
            fonte: {
              tipo: "grau",
              indice: 4,
              alfa: 1,
            },
            contra: null,
          },
          {
            token: "[data-theme=\"dark\"] ::selection/color",
            tipo: "texto",
            fonte: {
              tipo: "grau",
              indice: 0,
              alfa: 1,
            },
            contra: [
              {
                tipo: "grau",
                indice: 7,
                alfa: 1,
              },
            ],
          },
          {
            token: "[data-theme=\"dark\"] :focus-visible/outline-color",
            tipo: "componente",
            fonte: {
              tipo: "grau",
              indice: 4,
              alfa: 1,
            },
            contra: null,
          },
        ],
        semanticas: [
          {
            nome: "success",
            hex: "#9cb986",
          },
          {
            nome: "warning",
            hex: "#d3a55d",
          },
          {
            nome: "error",
            hex: "#f8869a",
          },
          {
            nome: "info",
            hex: "#85b6cf",
          },
        ],
        neutros: [
          "#f4f0e9",
          "#e6e1d8",
          "#c9c3b8",
          "#aaa59d",
          "#7d786e",
          "#56524a",
          "#3a3730",
          "#262420",
          "#161412",
          "#111111",
          "#0b0b0b",
        ],
        indices: {
          accent: 4,
          hover: 3,
          soft: null,
        },
        alfaDoSoft: 0.16,
      },
    };
