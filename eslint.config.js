import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
	{ ignores: ['dist/', '.tmp/', 'tests/test-files/'] },
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: {
				...globals.node,
			},
		},
		rules: {
			'no-console': 'off',
			// Replaces no-unused-vars, which typescript-eslint turns off
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
		},
	},
])
