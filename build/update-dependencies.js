const fs = require('fs');
const fileName = process.cwd() + '/package.json';
const config = require(fileName);

if (typeof config.devDependencies === 'undefined') {
  config.devDependencies = {};
}

Object.assign(config.devDependencies, config.ciDependencies);

fs.writeFile(fileName, JSON.stringify(config, null, 2), function (err) {
  if (err) {
    return console.log(err);
  }
  console.log('Writing to ' + fileName);
});
