module.exports = {
  transform: {'^.+\\.ts?$': 'ts-jest'},
  testEnvironment: 'node',
  testTimeout: 10000,
  // Allow /node_modules/ for CI testing
  transformIgnorePatterns: [],
  // Fix TypeError: Unable to require `.d.ts` file.
  // https://github.com/kulshekhar/ts-jest/issues/950
  globals: {
    'ts-jest': {
      isolatedModules: true
    },
  },
};
