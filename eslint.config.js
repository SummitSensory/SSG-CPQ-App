import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";

export default [
  { ignores: ["dist/**", "coverage/**", "playwright-report/**", "node_modules/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsparser, parserOptions: { sourceType: "module" } },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      // Underscore prefix = deliberately unused (Fastify handlers must accept
      // (req, reply) even when they ignore one).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],
      "no-console": "warn"
    }
  },
  {
    // Seed and other CLI scripts talk to the operator through stdout — that IS
    // their interface (e.g. printing the generated admin password once).
    files: ["prisma/**/*.ts", "scripts/**/*.ts"],
    rules: { "no-console": "off" }
  },
  prettier
];
