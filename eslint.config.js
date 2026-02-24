import js from '@eslint/js'
import globals from 'globals'

export default [
	js.configs.recommended,
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
			'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
		},
	},
]
