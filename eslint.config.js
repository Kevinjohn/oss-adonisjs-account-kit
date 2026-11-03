import { configPkg } from '@adonisjs/eslint-config'

export default [
  ...configPkg({
    ignores: ['build/**', 'tmp/**', 'examples/**', 'stubs/**', 'bin/demos/overlay/**'],
  }),
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@adonisjs/core/config',
              importNames: ['configProvider'],
              message:
                "'@adonisjs/core/config' exports configProvider only from Core 7.5.1; the peer floor is 7.0.0, so import it from '@adonisjs/core'.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/config.ts', 'src/config_*.ts', 'src/admission/config.ts', 'src/http/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ThrowStatement > NewExpression[callee.name=/^(Error|TypeError)$/]',
          message:
            'Throw a package error class, InvalidArgumentsException or RuntimeException at public seams.',
        },
      ],
    },
  },
]
