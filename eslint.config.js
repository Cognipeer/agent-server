import js from "@eslint/js";
import tseslint from "typescript-eslint";

// `npm run lint` checks the library sources; tests and docs are not linted.
export default tseslint.config(
  { ignores: ["dist/**", "docs/**", "test/**", "examples/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The agent-sdk and the drivers are loaded dynamically and typed loosely on purpose
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-this-alias": "off",
    },
  }
);
