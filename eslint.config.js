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
      "no-console": "warn"
    }
  },
  prettier
];
