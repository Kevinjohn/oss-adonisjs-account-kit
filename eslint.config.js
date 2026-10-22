import { configPkg } from '@adonisjs/eslint-config'

export default [
  ...configPkg({ ignores: ['stubs/**', 'examples/**', 'scripts/demos/overlay/**'] }),
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
]
