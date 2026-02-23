/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: [
    "**/dist/**",
    "**/node_modules/**",
    "**/coverage/**",
    "docker/**",
    "docs/**",
    "deploy/**",
  ],
  rules: {
    // TypeScript projects should rely on tsc for undefined vars/types.
    "no-undef": "off",

    // Start lenient; tighten to "error" once the codebase is clean.
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
    ],
  },
};
