/* eslint-disable sort-keys */

module.exports = {
	root: true,
	extends: ['moon', 'moon/node'],
	parserOptions: {
		project: 'tsconfig.json',
		tsconfigRootDir: __dirname,
	},
	overrides: [
		{
			files: ['tests/*.test.ts'],
			// These tests use node:test, not Jest.
			rules: {
				'@typescript-eslint/require-await': 'off',
				'jest/no-deprecated-functions': 'off',
				'jest/consistent-test-it': 'off',
				'jest/require-top-level-describe': 'off',
				'jest/expect-expect': 'off',
			},
		},
	],
};
