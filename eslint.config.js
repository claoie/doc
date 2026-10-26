import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "@typescript-eslint": tsPlugin, "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "@typescript-eslint/no-explicit-any": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-async-promise-executor": "error",
      "no-case-declarations": "error",
      "no-prototype-builtins": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["src/**/*.test.ts", "src/server/test-helpers.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  { ignores: ["build/**", "node_modules/**", "coverage/**", "data/**"] },
];
