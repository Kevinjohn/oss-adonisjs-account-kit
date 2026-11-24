export const requiredEnvHelperLines = [
  'const requiredEnv = (name: string): string => {',
  '  const value = process.env[name]',
  '  if (!value) throw new InvalidArgumentsException(`account_kit: ${name} must be configured`)',
  '  return value',
  '}',
]
