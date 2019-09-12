module.exports = {
  transform: {'^.+\\.ts?$': 'ts-jest'},
  testEnvironment: 'node',
  // allow /node_modules/ for CI testing
  transformIgnorePatterns: [],
};
