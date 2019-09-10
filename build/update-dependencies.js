const fs = require('fs');
const fileName = process.cwd() + '/package.json';
const config = require(fileName);

for (const dependency in config.ciDependencies) {
  if (!config.ciDependencies.hasOwnProperty(dependency)) {
    continue;
  }

  if (typeof config.dependencies[dependency] !== 'undefined') {
    config.dependencies[dependency] = config.ciDependencies[dependency];
    continue;
  }
  config.devDependencies[dependency] = config.ciDependencies[dependency];
}

const content = JSON.stringify(config, null, 2);
console.log('The new file content is \n', content);
fs.writeFile(fileName, content, function (err) {
  if (err) {
    return console.log(err);
  }
  console.log('Writing to ' + fileName);
});
