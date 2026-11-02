const tseslint = require('typescript-eslint');
const globals = require('globals');
const hooks = require('eslint-plugin-react-hooks');
const { builtinModules } = require('node:module');

module.exports = tseslint.config({
  files: ['server/mcp/ui/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'],
  extends: [...tseslint.configs.recommended],
  languageOptions: { globals: globals.browser },
  plugins: { 'react-hooks': hooks },
  rules: {
    ...hooks.configs.recommended.rules,
    'no-restricted-globals': ['error', 'process', 'Buffer', '__dirname', '__filename'],
    'no-restricted-imports': ['error', {
      paths: [...new Set(builtinModules.flatMap(name => [name, `node:${name.replace(/^node:/, '')}`]))],
      patterns: ['@client/*', '@server/*', '@/*', '**/client/**'],
    }],
  },
});
