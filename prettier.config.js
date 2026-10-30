export default {
  printWidth: 100,
  tabWidth: 2,
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  bracketSameLine: true,
  vueIndentScriptAndStyle: false,
  overrides: [
    {
      files: ['*.vue'],
      options: { singleQuote: true },
    },
  ],
}
