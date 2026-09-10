import parser from "@typescript-eslint/parser";
import plugin from "@typescript-eslint/eslint-plugin";
export default [{ ignores: ["node_modules/**"] }, { files: ["**/*.ts"], languageOptions: { parser }, plugins: { "@typescript-eslint": plugin }, rules: { "no-console": "off" } }];
