import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['node_modules/**', '.wrangler/**', 'dist/**'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
			],
			'@typescript-eslint/no-explicit-any': 'warn',
			'no-empty': ['error', { allowEmptyCatch: true }],
			// Match the existing codebase style (let-heavy) rather than churn
			// every declaration; `prefer-const` is not enforced.
			'prefer-const': 'off',
			// The R2 `include` option needs @ts-ignore against older type defs.
			'@typescript-eslint/ban-ts-comment': 'off',
		},
	},
);
