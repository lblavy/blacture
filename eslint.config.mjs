import js from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { sonarjs },
    rules: {
      complexity: ["error", 10],
      "sonarjs/cognitive-complexity": ["error", 15],
    },
  },
);
