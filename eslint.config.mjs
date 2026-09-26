// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'src/generated/', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // Product configuration is read only through ProductConfigService.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^(productConfigVersion|activeProductConfig)$/]',
          message:
            'Read Product configuration through ProductConfigService, not the database tables.',
        },
      ],
    },
  },
  {
    files: ['src/product-config/product-config.repository.ts', 'test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
