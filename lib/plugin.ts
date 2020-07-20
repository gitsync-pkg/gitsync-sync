import {Context} from '..';
import {ConfigPlugin} from '@gitsync/config';
import pEachSeries from 'p-each-series'

interface PluginPlugins {
  [key: string]: [Function?]
};

export interface PluginConfig {
  [key: string]: any;
}

export class Plugin {
  private plugins: PluginPlugins = {
    prepare: [],
    beforeCommit: [],
  };

  constructor(plugins: ConfigPlugin[]) {
    plugins.forEach(plugin => {
      let path: string;
      let config: PluginConfig;

      if (typeof plugin === 'string') {
        path = plugin;
        config = {};
      } else {
        [path, config = {}] = plugin;
      }

      const module = require(path);
      Object.keys(module).forEach(method => {
        if (typeof this.plugins[method] === 'undefined') {
          throw new Error(`Unsupported method "${method}" in plugin "${path}", please remove it from export`);
        }

        this.plugins[method].push((context: Context) => module[method](config, context));
      });
    });
  }

  async run(method: string, context: Context) {
    if (typeof this.plugins[method] === 'undefined') {
      throw new Error(`Call to unknown plugin method: ${method}`);
    }

    return pEachSeries(this.plugins[method], async (fn: Function) => fn(context));
  }
}
