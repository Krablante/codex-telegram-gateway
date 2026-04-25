import js from "@eslint/js";
import globals from "globals";

const jsFiles = [
  "src/**/*.js",
  "scripts/**/*.mjs",
  "test/**/*.js",
  "test-support/**/*.js",
];

export default [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
    ],
  },
  js.configs.recommended,
  {
    files: jsFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    // Lint is a fast bug-prone static-analysis gate, not a formatting gate.
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: true,
        varsIgnorePattern: "^_",
      }],
    },
  },
];
