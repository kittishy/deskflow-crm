import { execFileSync } from "node:child_process";

// Vercel ignoreCommand: exit 0 = ignora o deployment; exit 1 = faz build.
// Só pulamos mudanças comprovadamente sem efeito no app hospedado.
// Qualquer caminho desconhecido continua construindo por segurança.
try {
  const output = execFileSync("git", ["diff", "--name-only", "HEAD^", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  const changed = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const nonRuntimePrefixes = [
    "docs/",
    "evidence/",
    "tests/",
    ".github/",
    ".agents/",
    ".claude/",
  ];

  const rootDocs = new Set([
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "LICENSE",
    "LICENSE.md",
  ]);

  const onlyNonRuntime =
    changed.length > 0 &&
    changed.every(
      (file) =>
        rootDocs.has(file) ||
        nonRuntimePrefixes.some((prefix) => file.startsWith(prefix)),
    );

  if (onlyNonRuntime) {
    console.log(
      `Vercel: ${changed.length} mudança(s) sem efeito no runtime; deployment ignorado.`,
    );
    process.exit(0);
  }

  console.log("Vercel: mudança de runtime ou caminho desconhecido; fazendo build.");
  process.exit(1);
} catch {
  console.log("Vercel: não foi possível inspecionar o diff; fazendo build por segurança.");
  process.exit(1);
}
