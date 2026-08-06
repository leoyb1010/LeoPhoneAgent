import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/'],
  },
  {
    rules: {
      // `deepDeleteKeys` (transform.ts) is a pre-existing helper kept for upcoming
      // strip handlers; it predates lint being added to this package.
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^deepDeleteKeys$' }],
    },
  },
);
