// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')

module.exports = defineConfig([
  expoConfig,
  {
    // docs/example-txs/spike holds throwaway Node analysis scripts (see its README), not app code.
    ignores: ['dist/*', 'docs/example-txs/spike/*']
  }
])
