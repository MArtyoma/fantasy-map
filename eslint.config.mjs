import tseslint from '@typescript-eslint/eslint-plugin'
import parser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint-define-config'
import reactPlugin from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig({
  files: ['src/*.{js,jsx,ts,tsx}'],
  languageOptions: {
    parser: parser,
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
    },
  },
  plugins: {
    '@typescript-eslint': tseslint,
    react: reactPlugin,
    'react-hooks': reactHooks,
    'react-refresh': reactRefresh,
  },
  rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }] },
  settings: { react: { version: 'detect' } },
})
