import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Outillage de Claude Code : les copies de travail des agents
    // (.claude/worktrees/*) portent leur propre .next/ et leur propre code.
    ".claude/**",
  ]),
  // Retirer un champ par déstructuration (`const { updated_at: _x, ...reste } = row`)
  // est l'idiome des tests pour comparer une ligne hors horodatage.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
    },
  },
]);

export default eslintConfig;
