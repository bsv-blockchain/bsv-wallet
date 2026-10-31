/**
 * Playwright journeys. Separate from `npm test` so the unit suite does not
 * download or launch a browser. Inherits the app's jest-expo transform: the
 * driver imports the real wallet and bridge modules.
 */
const pkg = require('./package.json')

const config = {
  ...pkg.jest,
  testMatch: ['<rootDir>/e2e/**/*.e2e.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverage: false,
  testTimeout: 120000,
  maxWorkers: 1
}
delete config.coverageThreshold
module.exports = config
