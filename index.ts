import {Arguments} from 'yargs';
import git, {Git} from 'git-cli-wrapper';
import log from '@gitsync/log';
import {Config, ConfigPlugin} from '@gitsync/config';
import theme from 'chalk-theme';
import * as _ from 'lodash';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import * as npmlog from 'npmlog';
import * as ProgressBar from 'progress';
import * as micromatch from 'micromatch';
import * as inquirer from 'inquirer';
import {Plugin} from './lib/plugin';

const unlink = util.promisify(fs.unlink);
const mkdir = util.promisify(fs.mkdir);
const rename = util.promisify(fs.rename);

export interface SyncOptions {
  target: string;
  sourceDir: string;
  targetDir?: string;
  includeBranches?: string | string[];
  excludeBranches?: string | string[];
  includeTags?: string | string[];
  excludeTags?: string | string[];
  noTags?: boolean;
  after?: number | string;
  maxCount?: number;
  preserveCommit?: boolean;
  yes?: boolean;
  addTagPrefix?: string;
  removeTagPrefix?: string;
  filter?: string[];
  squash?: boolean;
  squashBaseBranch?: string;
  plugins?: ConfigPlugin[];
}

export type SyncArguments = Arguments<SyncOptions>;

export interface Tag {
  hash: string;
  annotated: boolean;
}

export interface Tags {
  [key: string]: Tag;
}

export interface Context {
  source: Git;
  target: Git;
  options: SyncOptions;
  getTargetHash: (hash: string) => Promise<string>;

  [key: string]: any;
}

export interface StringStringMap {
  [key: string]: string;
}

class Sync {
  private options: SyncOptions = {
    target: '.',
    sourceDir: '',
    targetDir: '.',
    preserveCommit: true,
    addTagPrefix: '',
    removeTagPrefix: '',
    squashBaseBranch: 'master',
    plugins: [],
  };

  private initHash: string;

  private source: Git;

  private target: Git;

  private currentBranch: string;

  private defaultBranch: string;

  private origBranch: string;

  private isContains: boolean;

  private conflictBranches: string[] = [];

  private tempBranches: any = {};

  private targetHashes: StringStringMap = {};

  private isConflict: boolean;

  private isHistorical: boolean;

  private workTree: Git;

  private conflictBranch: string;

  private config: Config;

  private plugin: Plugin;

  private context: Context;

  private env: StringStringMap;

  private sourcePaths: string[] = [];

  private targetPaths: string[] = [];

  private targetSquashes: any = {};

  async sync(options: SyncOptions) {
    this.config = new Config();
    this.initOptions(options);

    this.plugin = new Plugin(this.options.plugins);

    this.source = git('.');

    this.target = git(await this.config.getRepoDirByRepo(this.options, true));
    if (await this.target.run(['status', '--short'])) {
      throw new Error(
        `Target repository "${this.target.dir}" has uncommitted changes, please commit or remove changes before syncing.`,
      );
    }

    // @link https://git-scm.com/docs/gitglossary#Documentation/gitglossary.txt-aiddefpathspecapathspec
    const regex = /^:(!|\^|\/|\([a-z,]+\))(.+?)$/;
    this.options.filter.forEach(pathSpec => {
      let pathPrefix = '';
      let pathSuffix = '';

      if (pathSpec.substr(0, 1) === ':') {
        const matches = regex.exec(pathSpec);
        if (matches) {
          pathPrefix = `:${matches[1]}`;
          pathSuffix = matches[2];
        }
      }

      // Fallback to normal path
      if (!pathSuffix) {
        pathSuffix = pathSpec;
      }

      this.sourcePaths.push(pathPrefix + this.options.sourceDir + pathSuffix);
      this.targetPaths.push(pathPrefix + this.options.targetDir + pathSuffix);
    });
    if (!this.options.filter.length) {
      this.sourcePaths.push(this.options.sourceDir);
      this.targetPaths.push(this.options.targetDir);
    }

    // Use to skip `gitsync post-commit` command when running `gitsync update`
    if (process.env.GITSYNC_UPDATE) {
      this.env = {
        GITSYNC_UPDATE: process.env.GITSYNC_UPDATE,
      };
    }

    this.initHash = await this.target.run(['rev-list', '-n', '1', '--all']);

    this.initContext();
    await this.runPlugin('prepare');

    try {
      await this.syncCommits();
      await this.clean();
      log.info('Sync finished.');
    } catch (e) {
      await this.clean();

      let message = 'Sorry, an error occurred during sync.\n';
      if (npmlog.level !== 'verbose') {
        message += `
To retry your command with verbose logs:

    1. YOUR-COMMAND --log-level=verbose
`;
      }
      message += `
To reset to previous HEAD:

    1. cd ${this.target.dir}
    2. ${this.initHash ? `git reset --hard ${this.initHash}` : 'git rm --cached -r *'}
    ${!this.initHash ? '3. git update-ref -d HEAD' : ''}
`;

      log.error(message);
      throw e;
    }
  }

  private initOptions(options: SyncOptions) {
    Object.assign(this.options, options);
    // append a slash to make sure it's a dir, rather than a file
    this.options.sourceDir = path.normalize(`${this.config.parseSourceDir(this.options.sourceDir).realSourceDir}/`);
    this.options.targetDir = path.normalize(`${this.options.targetDir}/`);
    this.options.filter = this.toArray(this.options.filter);
  }

  protected async syncCommits() {
    const sourceBranches = await this.parseBranches(this.source);
    const targetBranches = await this.parseBranches(this.target);

    let firstLog = '';
    const sourceLogs = await this.getLogs(
      this.source,
      sourceBranches,
      this.sourcePaths,
      {},
      this.target,
      this.targetPaths,
      (hash: string) => {
        firstLog || (firstLog = hash);
      },
    );
    const targetLogs = await this.getLogs(
      this.target,
      targetBranches,
      this.targetPaths,
      {},
      this.source,
      this.sourcePaths,
    );

    // 找到当前仓库有,而目标仓库没有的记录
    const newLogsDiff = this.objectValueDiff(sourceLogs, targetLogs);
    const newLogs = await this.filterEmptyLogs(newLogsDiff);
    this.detectHistorical(newLogs, sourceLogs);

    const newCount = _.size(newLogs);
    const sourceCount = _.size(sourceLogs);
    const targetCount = _.size(targetLogs) + (_.size(newLogsDiff) - _.size(newLogs));
    log.info(
      `Commits: new: %s, exists: %s, source: %s, target: %s`,
      theme.info(newCount.toString()),
      theme.info((sourceCount - newCount).toString()),
      theme.info(sourceCount.toString()),
      theme.info(targetCount.toString()),
    );

    const newBranches = this.objectValueDiff(sourceBranches, targetBranches);
    log.info(
      'Branches: new: %s, exists: %s, source: %s, target: %s',
      theme.info(_.size(newBranches).toString()),
      theme.info((_.size(sourceBranches) - _.size(newBranches)).toString()),
      theme.info(_.size(sourceBranches).toString()),
      theme.info(_.size(targetBranches).toString()),
    );

    this.isContains = sourceCount - targetCount === newCount;
    log.debug(`source repository ${this.isContains ? 'contains' : 'does not contain'} target repostitory`);

    let filteredTags;
    if (!this.options.noTags) {
      filteredTags = await this.getFilteredTags();
    }

    if (!this.options.yes) {
      const {toSync} = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'toSync',
          message: 'Are you sure to sync?',
          default: false,
        },
      ]);
      if (!toSync) {
        return;
      }
    }

    const targetBranch = await this.target.getBranch();
    this.origBranch = targetBranch;

    if (this.options.squash) {
      await this.createSquashCommits(sourceBranches, targetBranches);
    } else {
      const branch = await this.getBranchFromLog(firstLog);
      this.currentBranch = this.defaultBranch = this.toLocalBranch(branch);

      if (this.currentBranch && targetBranch !== this.defaultBranch) {
        if (!targetBranches.includes(this.defaultBranch)) {
          await this.target.run(['checkout', '-b', this.defaultBranch]);
        } else {
          await this.target.run(['checkout', this.defaultBranch]);
        }
      }

      const hashes = _.reverse(Object.keys(newLogs));

      const progressBar = this.createProgressBar(newCount);
      for (const key in hashes) {
        await this.applyPatch(hashes[key]);
        this.tickProgressBar(progressBar);
      }

      log.info('Synced %s %s.', theme.info(newCount.toString()), this.pluralize('commit', newCount));

      await this.syncBranches(sourceBranches, targetBranches);
    }

    if (this.origBranch) {
      // If target is a new repository without commits, it doesn't have any branch
      const branches = await this.target.run(['branch']);
      if (branches.includes(this.origBranch)) {
        await this.target.run(['checkout', this.origBranch]);
      }
    }

    if (this.conflictBranches.length) {
      // TODO 1. normalize dir 2. generate "gitsync ..." command
      let branchTips = '';
      this.conflictBranches.forEach((branch: string) => {
        branchTips += `    ${theme.info(branch)} conflict with ${theme.info(this.getConflictBranchName(branch))}\n`;
      });

      const branchCount = _.size(this.conflictBranches);
      log.warn(`
The target repository contains conflict ${this.pluralize(
        'branch',
        branchCount,
        'es',
      )}, which need to be resolved manually.

The conflict ${this.pluralize('branch', branchCount, 'es')}:

${branchTips}
Please follow the steps to resolve the conflicts:

    1. cd ${path.join(this.target.dir, this.options.targetDir)}
    2. git checkout BRANCH-NAME // Replace BRANCH-NAME to your branch name
    3. git merge ${this.getConflictBranchName('BRANCH-NAME')}
    4. // Follow the tips to resolve the conflicts
    5. git branch -d ${this.getConflictBranchName('BRANCH-NAME')} // Remove temp branch
    6. "gitsync ..." to sync changes back to current repository
`);
      throw new Error('conflict');
    }

    if (!this.options.noTags) {
      await this.syncTags(filteredTags);
    }
  }

  private parseHash(hash: string) {
    const fullHash = hash;

    // Switch to target branch
    const isCurBranch = hash.substr(0, 1) === '*';
    hash = this.split(hash, '#')[1];
    let parent: string;
    [hash, parent] = this.split(hash, ' ');

    // Use Git empty tree hash as first commit's parent
    if (!parent) {
      parent = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    }

    return [hash, parent];
  }

  private async createSquashCommits(sourceBranches: any, targetBranches: any) {
    log.debug('Start squash commit');

    if (!sourceBranches.includes(this.options.squashBaseBranch)) {
      throw new Error(`Squash branch "${this.options.squashBaseBranch}" does not exists`);
    }
    sourceBranches = this.moveToFirst(sourceBranches, this.options.squashBaseBranch);

    const skipped = 0;
    const progressBar = this.createProgressBar(Object.keys(sourceBranches).length);

    for (const key in sourceBranches) {
      const sourceBranch: string = sourceBranches[key];
      await this.syncSquashBranch(sourceBranch, targetBranches);

      this.tickProgressBar(progressBar);
    }
  }

  private async syncSquashBranch(sourceBranch: string, targetBranches: string[]) {
    const localBranch = this.toLocalBranch(sourceBranch);
    const sourceBranchHash = await this.source.run(['rev-parse', sourceBranch]);

    if (_.includes(targetBranches, sourceBranch)) {
      const squashLogs = {};
      const sourceLogs = await this.getLogs(
        this.source,
        [sourceBranch],
        this.sourcePaths,
        {},
        this.target,
        this.targetPaths,
      );
      const targetLogs = await this.getLogs(
        this.target,
        [sourceBranch],
        this.targetPaths,
        squashLogs,
        this.source,
        this.sourcePaths,
      );

      if (localBranch === this.options.squashBaseBranch) {
        // Record squash range from exists branch exists commits
        this.targetSquashes = squashLogs;
      }

      // 找到当前仓库有,而目标仓库没有的记录
      const newLogsDiff = this.objectValueDiff(sourceLogs, targetLogs);
      const newLogs = await this.filterEmptyLogs(newLogsDiff);
      this.detectHistorical(newLogs, sourceLogs);

      const hashes = Object.keys(newLogs);
      if (hashes.length === 0) {
        log.debug(`Branch "${localBranch}" is up to date, skipping`);
        return;
      }

      const [hash, sourceStartHash] = this.parseHash(hashes[hashes.length - 1]);
      await this.target.run(['checkout', localBranch]);
      const newHash = await this.createSquashCommit(sourceStartHash, sourceBranchHash, localBranch);

      if (localBranch === this.options.squashBaseBranch) {
        // Record squash range from exists branch new commit
        this.targetSquashes[newHash] = newLogsDiff;
      }

      return;
    }

    const newHash = await this.createNewSquashBranch(sourceBranch);
    if (localBranch === this.options.squashBaseBranch) {
      // Record squash range from new branch new commit
      this.targetSquashes[newHash] = await this.getLogs(
        this.source,
        [sourceBranch],
        this.sourcePaths,
        {},
        this.target,
        this.targetPaths,
      );
    }
  }

  private async createNewSquashBranch(sourceBranch: string) {
    log.debug(`Target branch "${sourceBranch}" does not exist`);

    let commitStartHash: string;
    if (sourceBranch === this.options.squashBaseBranch) {
      // Create new branch from root
      commitStartHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    } else {
      await this.target.run(['checkout', '-b', sourceBranch, this.options.squashBaseBranch]);
      commitStartHash = await this.source.run(['rev-parse', this.options.squashBaseBranch]);
    }

    const commitEndHash = await this.source.run(['rev-parse', sourceBranch]);
    return await this.createSquashCommit(commitStartHash, commitEndHash, sourceBranch, true);
  }

  private async createSquashCommit(startHash: string, endHash: string, branch: string, isNew = false) {
    // merge
    if (startHash.includes(' ')) {
      const parents = startHash.split(' ');
      if (this.isContains && !this.isHistorical) {
        await this.overwrite(endHash, parents);
      } else {
        // TODO squash sync to conflict branch
      }
      await this.commitSquash(startHash, endHash);
      return;
    }

    // Create patch
    const args = this.withPaths(
      ['diff', '--stat', '--binary', '--color=never', `${startHash}..${endHash}`],
      this.sourcePaths,
    );

    let patch = await this.source.run(args);

    // Add new lines to avoid git-apply return error
    // s
    // """
    // error: corrupt patch at line xxx
    // error: could not build fake ancestor
    // """
    // @see sync src/Symfony/Bridge/Monolog/
    //
    // """
    // error: corrupt binary patch at line xxx:
    // """
    // @see sync src/Symfony/Component/Form/
    patch += '\n\n';

    // Apply patch
    let patchArgs = [
      'apply',
      '-3',
      // @see \GitSyncTest\Command\SyncCommandTest::testApplySuccessWhenChangedLineEndings
      '--ignore-whitespace',
    ];

    patchArgs.push(`-p${this.getPathDepth(this.options.sourceDir)}`);

    if (this.options.targetDir !== './') {
      patchArgs = patchArgs.concat(['--directory', this.options.targetDir]);
    }

    try {
      await this.target.run(patchArgs, {input: patch});
    } catch (e) {
      log.info('Apply patch fail, sync changes to conflict branch');

      if (await this.target.hasCommit()) {
        await this.target.run(['reset', '--hard', 'HEAD']);

        if (!isNew) {
          const conflictBranch = this.getConflictBranchName(branch);
          await this.target.run(['checkout', '-b', conflictBranch, branch]);
          this.conflictBranches.push(branch);
        }
      }

      await this.overwrite(endHash, [startHash]);
    }

    return await this.commitSquash(startHash, endHash);
  }

  private async commitSquash(startHash: string, endHash: string) {
    // Ignore untracked files
    await this.target.run(['add', '-u']);
    await this.target.run([
      'commit',
      '--allow-empty',
      '-am',
      `chore(sync): squash commits from ${startHash} to ${endHash}`,
    ]);
    return await this.target.run(['rev-parse', 'HEAD']);
  }

  private async getFilteredTags() {
    const sourceTags = await this.getTags(this.source);
    const targetTags = await this.getTags(this.target);

    const newTags: Tags = this.keyDiff(sourceTags, targetTags);

    let include = this.options.includeTags;
    if (this.options.removeTagPrefix) {
      include = this.toArray(include);
      include.push(`${this.options.removeTagPrefix}*`);
    }

    let filterTags: Tags = this.filterObjectKey(newTags, include, this.options.excludeTags);
    filterTags = this.transformTagKey(filterTags, this.options.removeTagPrefix, this.options.addTagPrefix);
    // Tags may exist after transformed
    filterTags = this.keyDiff(filterTags, targetTags);

    const total = _.size(sourceTags);
    const newCount = _.size(newTags);
    const filteredCount = _.size(filterTags);
    log.info(
      'Tags: new: %s, exists: %s, source: %s, target: %s',
      theme.info(filteredCount.toString()),
      theme.info((total - newCount).toString()),
      theme.info(total.toString()),
      theme.info(_.size(targetTags).toString()),
    );
    return filterTags;
  }

  private transformTagKey(tags: Tags, removeTagPrefix: string, addTagPrefix: string) {
    if (!removeTagPrefix && !addTagPrefix) {
      return tags;
    }

    const newTags: Tags = {};
    Object.keys(tags).forEach((tag: string) => {
      const newTag = addTagPrefix + tag.substring(removeTagPrefix.length);
      newTags[newTag] = tags[tag];
    });

    return newTags;
  }

  private async filterEmptyLogs(logs: StringStringMap) {
    const newLogs: StringStringMap = {};
    for (let hash in logs) {
      const fullHash = hash;

      hash = this.split(hash, '#')[1];
      let parent: string;
      [hash, parent] = this.split(hash, ' ');

      const targetHash = await this.getTargetHash(hash);
      if (!targetHash) {
        newLogs[fullHash] = logs[fullHash];
        continue;
      }

      const result = await this.target.run(['diff-tree', '--no-commit-id', '--name-only', '-r', targetHash]);
      if (result) {
        newLogs[fullHash] = logs[fullHash];
      }

      // Ignore empty commit
    }
    return newLogs;
  }

  private detectHistorical(newLogs: StringStringMap, sourceLogs: StringStringMap) {
    const newLogValues = Object.values(newLogs);
    const newLogLast = newLogValues.length - 1;
    this.isHistorical = newLogValues[newLogLast] !== Object.values(sourceLogs)[newLogLast];
    log.debug(`Sync ${this.isHistorical ? 'historical' : 'new'} commits to target`);
  }

  protected async syncBranches(sourceBranches: any, targetBranches: any) {
    let skipped = 0;
    const progressBar = this.createProgressBar(Object.keys(sourceBranches).length);

    for (const key in sourceBranches) {
      const sourceBranch: string = sourceBranches[key];
      const localBranch = this.toLocalBranch(sourceBranch);

      if (!_.includes(targetBranches, sourceBranch)) {
        const result = await this.createOrUpdateTargetBranch(sourceBranch);
        if (!result) {
          skipped++;
        }
        this.tickProgressBar(progressBar);
        continue;
      }

      const sourceHash = await this.source.run(['rev-parse', sourceBranch]);
      const targetHash = await this.findTargetTagHash(sourceHash);
      if (!targetHash) {
        skipped++;
        await this.logCommitNotFound(sourceHash, sourceBranch);
        this.tickProgressBar(progressBar);
        continue;
      }

      const targetBranchHash = await this.target.run(['rev-parse', localBranch]);
      if (targetBranchHash === targetHash) {
        log.debug(`Branch "${localBranch}" is up to date, skipping`);
        this.tickProgressBar(progressBar);
        continue;
      }

      const result = await this.target.run(['merge-base', targetBranchHash, targetHash]);

      if (result === targetBranchHash) {
        // 新的分支包含老的，说明没有冲突，直接更新老分支
        const branchResult = await this.createOrUpdateTargetBranch(sourceBranch);
        if (!branchResult) {
          skipped++;
        }
      } else if (result === targetHash) {
        // 目标分支有新的提交，不用处理
        this.tickProgressBar(progressBar);
        continue;
      } else {
        // or this.conflictBranches.includes(localBranch)
        if (localBranch === this.currentBranch) {
          this.tickProgressBar(progressBar);
          continue;
        }

        await this.target.run(['branch', '-f', this.getConflictBranchName(localBranch), targetHash]);
        this.conflictBranches.push(localBranch);
      }
      this.tickProgressBar(progressBar);
    }

    log.info(
      'Synced %s, skipped %s branches.',
      theme.info((_.size(sourceBranches) - skipped).toString()),
      theme.info(skipped.toString()),
    );
  }

  protected async createOrUpdateTargetBranch(sourceBranch: string) {
    const sourceHash = await this.source.run(['rev-parse', sourceBranch]);
    const targetHash = await this.findTargetTagHash(sourceHash);
    if (targetHash) {
      // Cannot update the current branch, so use reset instead
      sourceBranch = this.toLocalBranch(sourceBranch);
      if (sourceBranch === this.currentBranch) {
        if (this.isContains) {
          // Update target HEAD only if source fully contains target
          // otherwise, target commits that not in the source will be lost
          await this.target.run(['reset', '--hard', targetHash]);
        } else {
          log.info(
            'Target repository has commits that have not been sync back to source repository, ' +
            `do not update "${sourceBranch}" branch to avoid lost commits`,
          );
        }
      } else {
        await this.target.run(['branch', '-f', sourceBranch, targetHash]);
      }

      return true;
    }
    await this.logCommitNotFound(sourceHash, sourceBranch);
    return false;
  }

  protected async findTargetTagHash(sourceHash: string) {
    const sourceDirHash = await this.findDirHash(sourceHash);
    if (!sourceDirHash) {
      return false;
    }

    const targetHash = this.getTargetHash(sourceDirHash);
    if (!targetHash) {
      return false;
    }

    return targetHash;
  }

  protected async logCommitNotFound(sourceHash: string, sourceBranch: string) {
    const result = await this.source.run(['log', '--format=%ct %s', '-1', sourceHash]);
    const [date, message] = this.explode(' ', result, 2);
    log.warn(`Commit not found in target repository, branch: ${sourceBranch}, date: ${date}, subject: ${message}`);
  }

  protected async applyPatch(hash: string) {
    const fullHash = hash;

    // Switch to target branch
    let isCurBranch = hash.substr(0, 1) === '*';
    hash = this.split(hash, '#')[1];
    let parent: string;
    [hash, parent] = this.split(hash, ' ');

    // TODO multi roots are not supported, fallback to current branch
    if (!parent && !isCurBranch) {
      isCurBranch = true;
    }

    // Use Git empty tree hash as first commit's parent
    if (!parent) {
      parent = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    }

    const parents = parent.split(' ');

    let branch: string;
    if (!isCurBranch) {
      branch = parents[0];
      await this.checkoutTempBranch(branch);
      this.currentBranch = branch;
    } else if (this.currentBranch !== this.defaultBranch) {
      await this.target.run(['checkout', this.defaultBranch]);
      this.currentBranch = this.defaultBranch;
    }

    if (parents.length > 1) {
      await this.mergeParents(hash, parents);
      return;
    }

    // Create patch
    const args = this.withPaths(
      [
        'log',
        '-p',
        '--reverse',
        '-m',
        '--stat',
        '--binary',
        '-1',
        '--color=never',
        // Commit body may contains *diff like* codes, which cause git-apply fail
        // @see \GitSyncTest\Command\SyncCommandTest::testCommitBodyContainsDiff
        '--format=%n',
        hash,
      ],
      this.sourcePaths,
    );

    let patch = await this.source.run(args);

    // Add new lines to avoid git-apply return error
    // s
    // """
    // error: corrupt patch at line xxx
    // error: could not build fake ancestor
    // """
    // @see sync src/Symfony/Bridge/Monolog/
    //
    // """
    // error: corrupt binary patch at line xxx:
    // """
    // @see sync src/Symfony/Component/Form/
    patch += '\n\n';

    // Apply patch
    let patchArgs = [
      'apply',
      '-3',
      // @see \GitSyncTest\Command\SyncCommandTest::testApplySuccessWhenChangedLineEndings
      '--ignore-whitespace',
    ];

    patchArgs.push(`-p${this.getPathDepth(this.options.sourceDir)}`);

    if (this.options.targetDir !== './') {
      patchArgs = patchArgs.concat(['--directory', this.options.targetDir]);
    }

    try {
      await this.target.run(patchArgs, {input: patch});
    } catch (e) {
      if (this.isContains) {
        if (this.isHistorical) {
          await this.syncToConflictBranch(hash);
        }
        await this.overwrite(hash, parents);
      } else {
        if (!this.isConflict) {
          await this.syncToConflictBranch(hash);
          await this.applyPatch(fullHash);
          return;
        }
        await this.syncToConflictBranch(hash);
      }
    }

    await this.commit(hash);
    this.setTargetHash(hash, await this.target.run(['rev-parse', 'HEAD']));
  }

  protected async syncToConflictBranch(hash: string) {
    await this.target.run(['checkout', '--theirs', '.']);

    if (!this.isConflict) {
      // 找到冲突前的记录，从这里开始创建branch
      const log = await this.source.run(
        this.withPaths(['log', '--format=%ct %B', '-1', '--skip=1', hash], this.sourcePaths),
      );

      let targetHash;
      if (log) {
        const [date, message] = this.explode(' ', log, 2);
        const shortMessage = this.explode('\n', message, 2)[0];
        targetHash = await this.target.run([
          'log',
          `--after=${date}`,
          `--before=${date}`,
          '--grep',
          shortMessage,
          '--fixed-strings',
          '--format=%H',
          '--all',
        ]);
      }

      if (!targetHash) {
        // @see test: change content then rename cause conflict
        // Fallback to current hash
        targetHash = await this.target.run(['rev-parse', 'HEAD']);
      }

      await this.target.run(['reset', '--hard', 'HEAD']);
      const branch: string = await this.target.getBranch();
      this.conflictBranch = this.getConflictBranchName(branch);
      await this.target.run(['checkout', '-b', this.conflictBranch, targetHash]);
      this.isConflict = true;
      this.conflictBranches.push(branch);
    }
  }

  protected async overwrite(hash: string, parents: string[]) {
    log.debug(`Start overwrite files from ${hash} to ${parents}`);

    const results = [];
    for (const i in parents) {
      const result = await this.source.run(
        this.withPaths(['diff-tree', '--name-status', '-r', parents[i], hash], this.sourcePaths),
      );
      if (result) {
        results.push(result);
      }
    }
    // Ignore empty commit
    if (!results.length) {
      return;
    }

    let removeLength: number;
    if (this.options.sourceDir === './') {
      removeLength = 0;
    } else {
      removeLength = this.options.sourceDir.length;
    }

    const files: StringStringMap = this.parseChangedFiles(results.join('\n'));

    const removeFiles: string[] = [];
    const updateFiles: string[] = [];

    _.forEach(files, (status, file) => {
      if (status === 'D') {
        removeFiles.push(file);
      } else {
        updateFiles.push(file);
      }
    });

    // @link https://stackoverflow.com/a/39948726
    const tempDir = `${this.target.dir}/.git/gitsync-worktree`;
    const workTree = await this.getWorkTree(this.source, tempDir);
    await workTree.run(['checkout', '-f', hash, '--'].concat(updateFiles));

    const targetFullDir = `${this.target.dir}/${this.options.targetDir}`;

    // Delete first and then update, so that when the change is renamed,
    // ensure that the file will not be deleted.
    removeFiles.forEach(file => {
      const targetFile = `${targetFullDir}/${file.substr(removeLength)}`;
      if (fs.existsSync(targetFile)) {
        unlink(targetFile);
      }
    });

    const targetFiles = [];
    for (const key in updateFiles) {
      const file = updateFiles[key];
      const targetFile = file.substr(removeLength);

      targetFiles.push(path.join(this.options.targetDir, targetFile));
      const target = `${targetFullDir}/${targetFile}`;

      const dir = path.dirname(target);
      if (!fs.existsSync(dir)) {
        await mkdir(path.dirname(target), {recursive: true});
      }
      await rename(`${tempDir}/${file}`, target);
    }

    await this.target.run(['add'].concat(targetFiles));
  }

  protected parseChangedFiles(result: string) {
    const files: StringStringMap = {};

    result
      .trim()
      .split('\n')
      .forEach((line: string) => {
        const [status, file] = line.split('\t');
        files[file] = status.substr(0, 1);
      });

    return files;
  }

  protected async getWorkTree(repo: Git, tempDir: string) {
    if (!this.workTree) {
      await repo.run(['worktree', 'add', '-f', tempDir, '--no-checkout', '--detach']);
      this.workTree = git(tempDir);
    }
    return this.workTree;
  }

  protected async syncTags(filterTags: Record<string, Tag>) {
    const filteredCount = _.size(filterTags);

    let skipped = 0;
    const progressBar = this.createProgressBar(filteredCount);
    for (const name in filterTags) {
      const tag: Tag = filterTags[name];
      let targetHash = await this.findTargetTagHash(tag.hash);

      if (!targetHash) {
        targetHash = await this.findTargetHashFromSquashLogs(tag.hash);
      }

      if (!targetHash) {
        const result = await this.source.run(['log', '--format=%ct %s', '-1', tag.hash]);
        const [date, message] = this.explode(' ', result, 2);

        log.warn(`Commit not found in target repository, tag: ${name}, date: ${date}, subject: ${message}`);
        skipped++;
        this.tickProgressBar(progressBar);
        continue;
      }

      // 如果有annotation，同步过去
      const args = ['tag', name, targetHash];
      if (tag.annotated) {
        args.push('-m');
        args.push(await this.source.run(['tag', '-l', '--format=%(contents)', name]));
      }
      await this.target.run(args);
      this.tickProgressBar(progressBar);
    }

    log.info(
      'Synced %s, skipped %s tags.',
      theme.info((filteredCount - skipped).toString()),
      theme.info(skipped.toString()),
    );
  }

  private async findDirHash(sourceHash: string) {
    return await this.source.run(this.withPaths(['log', '--format=%h', '-1', sourceHash], this.sourcePaths));
  }

  private async findTargetHashFromSquashLogs(sourceHash: string) {
    const sourceDirHash = await this.findDirHash(sourceHash);
    if (!sourceDirHash) {
      return false;
    }

    for (const targetHash in this.targetSquashes) {
      for (const logHash in this.targetSquashes[targetHash]) {
        if (logHash.includes(`#${sourceDirHash}`)) {
          return targetHash;
        }
      }
    }
    return '';
  }

  protected async getTags(repo: Git) {
    // Check if the repo has tag, because "show-ref" will return error code 1 when no tags
    if (!(await repo.run(['rev-list', '-n', '1', '--tags']))) {
      return {};
    }

    const tags: Record<string, Tag> = {};
    const output = await repo.run(['show-ref', '--tags', '-d']);

    // Example: ada25d8079f998939893a9ec33f4006d99a19554 refs/tags/v1.2.0^{}
    const regex = /^(.+?) refs\/tags\/(.+?)(\^\{\})?$/;
    output.split('\n').forEach((row: string) => {
      const matches = regex.exec(row);
      tags[matches[2]] = {
        hash: matches[1],
        annotated: typeof matches[3] !== 'undefined',
      };
    });

    return tags;
  }

  protected async clean() {
    await this.removeTempBranches(this.target);
    if (this.workTree) {
      await this.source.run(['worktree', 'remove', '-f', this.workTree.dir]);
      this.workTree = null;
    }
  }

  protected async checkoutTempBranch(branch: string) {
    const name = `sync-${branch}`;
    await this.target.run(['checkout', '-B', name, await this.getTargetHash(branch)]);
    this.tempBranches[name] = true;
  }

  protected async removeTempBranches(target: Git) {
    const branches = Object.keys(this.tempBranches);
    if (branches.length) {
      await target.run(['branch', '-D'].concat(branches));
    }
  }

  protected setTargetHash(hash: string, target: string) {
    this.targetHashes[hash] = target;
  }

  protected async getTargetHash(hash: string) {
    if (typeof this.targetHashes[hash] !== 'undefined') {
      return this.targetHashes[hash];
    }

    // Use the first line of raw body (%B), instead of subject (%s),
    // because git will convert commit message "a\nb" to "a b" as subject,
    // so search by "a b" won't match the log.
    // @see SyncCommandTest::testSearchCommitMessageContainsLineBreak
    const log = await this.source.run(['log', '--format=%ct %at %B', '-1', hash]);

    let [committerDate, authorDate, message] = this.explode(' ', log, 3);
    if (message.includes('\n')) {
      message = this.split(message, '\n')[0];
    }

    const match = this.parseSquashMessage(message);
    if (match) {
      return match[2];
    }

    // Here we assume that a person will not commit the same message in the same second.
    // This is the core logic to sync commits between two repositories.
    let target = await this.target.run(
      this.withPaths(
        [
          'log',
          `--after=${committerDate}`,
          `--before=${committerDate}`,
          '--grep',
          message,
          '--fixed-strings',
          '--format=%H',
          '--all',
        ],
        this.targetPaths,
      ),
      {
        // Target repository may not have any commits, so we mute the error.
        mute: true,
      },
    );

    if (!target || target.includes('\n')) {
      // Case 1: committer date may be changed by rebase.
      //
      // Case 2: git log assumes that commits are sorted by date descend,
      // and stops searching when the committer date is less than the specified date (--after option).
      // If commits are not sorted by date descend (for example, merge or rebase causes the date order changed),
      // the commit may not be found.
      //
      // Case 3: rebase causes same commit subject have same commit time, so target will contains `\n`
      //
      // So we need to remove the date limit and search again.
      const logs = await this.target.run(
        this.withPaths(['log', '--grep', message, '--fixed-strings', '--format=%H %at', '--all'], this.targetPaths),
        {
          mute: true,
        },
      );
      const hashes: string[] = [];
      logs.split('\n').forEach(log => {
        const [hash, date] = log.split(' ');
        if (date === authorDate) {
          hashes.push(hash);
        }
      });
      target = hashes.join('\n');
    }

    if (target.includes('\n')) {
      throw new Error(
        `Expected to return one commit, but returned more than one commit with the same message in the same second, committer date: ${committerDate}, message: ${message}: hashes: ${target}`,
      );
    }

    this.targetHashes[hash] = target;
    return target;
  }

  protected async mergeParents(hash: string, parents: string[]) {
    const args = [
      'merge',
      '--no-ff',
      // File may be changed after merging (no matter success or fail), before committing，
      // so we should stop, overwrite files to make sure files up to date, then commit.
      '--no-commit',
    ];

    for (const i in parents) {
      args.push(await this.getTargetHash(parents[i]));
    }

    try {
      await this.target.run(args);
    } catch (e) {
      // Ignore merge fail
    }

    await this.handleConflict(hash, parents);
    await this.commit(hash);
    this.setTargetHash(hash, await this.target.run(['rev-parse', 'HEAD']));
  }

  protected async commit(hash: string) {
    // Ignore untracked files
    await this.target.run(['add', '-u']);

    await this.runPlugin('beforeCommit');

    const commit = await this.source.run(['show', '-s', '--format=%an|%ae|%ai|%cn|%ce|%ci|%B', hash]);
    // TODO split
    const parts: string[] = this.explode('|', commit, 7);
    await this.target.run(['commit', '--allow-empty', '-am', parts[6]], {
      env: Object.assign(
        this.options.preserveCommit
          ? {
            GIT_AUTHOR_NAME: parts[0],
            GIT_AUTHOR_EMAIL: parts[1],
            GIT_AUTHOR_DATE: parts[2],
            GIT_COMMITTER_NAME: parts[3],
            GIT_COMMITTER_EMAIL: parts[4],
            GIT_COMMITTER_DATE: parts[5],
          }
          : {},
        this.env,
      ),
    });
  }

  protected async handleConflict(hash: string, parents: string[]) {
    if (this.isContains && !this.isHistorical) {
      await this.overwrite(hash, parents);
    } else {
      await this.syncToConflictBranch(hash);
    }
  }

  protected async getLogs(
    repo: Git,
    revisions: string[],
    paths: string[],
    squashLogs: any = {},
    targetRepo: Git,
    targetPaths: string[],
    logCallback: Function = null,
  ) {
    // Check if the repo has commit, because "log" will return error code 128
    // with message "fatal: your current branch 'master' does not have any commits yet" when no commits
    if (!(await repo.run(['rev-list', '-n', '1', '--all']))) {
      return {};
    }

    let args = [
      'log',
      '--graph',
      // Use author timestamp instead of committer timestamp,
      // since that committer timestamp will be changed on rebase by default
      '--format=#%H %P-%at %s',
      // Include "TREESAME" parent
      '--full-history',
      '--simplify-merges',
    ];

    if (this.options.after) {
      args = args.concat(['--after', this.options.after.toString()]);
    }

    if (this.options.maxCount) {
      args.push(`-${this.options.maxCount}`);
    }

    if (revisions.length) {
      args = args.concat(revisions);
    } else {
      args.push('--all');
    }

    // Do not specify root directory, so that logs will contain *empty* commits (include merges)
    args = this.withPaths(args, paths);

    const result = await repo.run(args);
    if (!result) {
      return {};
    }

    let logs: StringStringMap = {};
    const rows = result.split('\n');
    for (const index in rows) {
      const row = rows[index];

      if (!row.includes('*')) {
        continue;
      }

      const [hash, detail] = this.split(row, '-');

      if (logCallback) {
        logCallback(hash, detail);
      }

      // Expand squashed commit
      const matches = this.parseSquashMessage(detail);
      if (matches) {
        log.debug(`Expand squashed commits from ${matches[1]} to ${matches[2]}`);
        const [squashHash] = this.parseHash(hash);
        squashLogs[squashHash] = await this.getLogs(
          targetRepo,
          [`${matches[1]}..${matches[2]}`],
          targetPaths,
          squashLogs,
          repo,
          paths,
        );
        logs = Object.assign(logs, squashLogs[squashHash]);
        continue;
      }

      logs[hash] = detail;
    }
    return logs;
  }

  protected async parseBranches(repo: Git) {
    const branches = await this.getBranches(repo);

    const conflicts = [];
    const pattern = this.getConflictBranchName('');
    for (const branch of branches) {
      if (branch.endsWith(pattern)) {
        conflicts.push(branch);
      }
    }

    if (conflicts.length) {
      throw new Error(
        `Repository "${repo.dir}" has unmerged conflict branches "${conflicts.join(
          ', ',
        )}", please merge or remove branches before syncing.`,
      );
    }

    return this.filter(branches, this.options.includeBranches, this.options.excludeBranches);
  }

  protected toArray(item: any) {
    if (!item) {
      return [];
    }

    if (!Array.isArray(item)) {
      return [item];
    }

    return item;
  }

  protected filter(array: any[], include: string | string[], exclude: string | string[]): any[] {
    include = this.toArray(include);
    exclude = this.toArray(exclude);

    if (include.length === 0 && exclude.length === 0) {
      return array;
    }

    const patterns = include.concat(exclude.map(item => `!${item}`));
    if (include.length === 0) {
      patterns.unshift('**');
    }
    return micromatch(array, patterns);
  }

  protected filterObjectKey(object: Record<string, any>, include: string | string[], exclude: string | string[]) {
    include = this.toArray(include);
    exclude = this.toArray(exclude);

    if (include.length === 0 && exclude.length === 0) {
      return object;
    }

    const patterns = include.concat(exclude.map(item => `!${item}`));
    if (include.length === 0) {
      patterns.unshift('**');
    }

    const keys = micromatch(Object.keys(object), patterns);
    return keys.reduce((newObject: Record<string, any>, key: string) => {
      newObject[key] = object[key];
      return newObject;
    }, {});
  }

  protected async getBranches(repo: Git) {
    const result = await repo.run(['branch', '-a']);
    if (!result) {
      return [];
    }

    const branches: string[] = [];
    result.split('\n').forEach((name: string) => {
      // "  remotes/origin/1.0" => "remotes/origin/1.0"
      name = name.substr(2);

      // "remotes/origin/1.0" => "origin/1.0"
      if (name.startsWith('remotes/')) {
        name = name.substr(8);
      }

      // Ignore "remotes/origin/HEAD -> origin/1.0"
      if (name.includes('origin/HEAD -> ')) {
        return;
      }

      if (name.startsWith('origin/')) {
        const localName = name.substr(7);
        if (branches.includes(localName)) {
          return;
        }
      }

      branches.push(name);
    });

    return branches;
  }

  protected async getBranchFromLog(log: string) {
    if (!log) {
      return '';
    }

    log = this.split(log, '#')[1];
    const hash = this.split(log, ' ')[0];

    let result = await this.source.log(['--format=%D', '-1', hash]);
    if (result) {
      // Example:
      // 1. HEAD -> master, tag: 1.0.1, tag: 1.0.0, origin/master
      // 2. tag: 1.0.1, tag: 1.0.0, origin/branch
      let branch = '';
      for (const ref of result.split(', ')) {
        if (ref.startsWith('tag: ')) {
          continue;
        }

        if (ref.includes(' -> ')) {
          branch = ref.split(' -> ')[1];
        } else {
          branch = ref;
        }
        break;
      }
      return branch;
    }

    result = await this.source.run(['branch', '--no-color', '--contains', hash]);
    // Example: * master
    const branch = this.split(result, '\n')[0];
    return branch.substr(2);
  }

  protected toLocalBranch(branch: string) {
    if (branch.startsWith('origin/')) {
      return branch.substr(7);
    }
    return branch;
  }

  protected objectValueDiff(obj1: any, obj2: any): {} {
    const result: any = {};
    for (const key in obj1) {
      if (!_.includes(obj2, obj1[key])) {
        result[key] = obj1[key];
      }
    }
    return result;
  }

  protected keyDiff(obj1: any, obj2: any) {
    const result: any = {};
    for (const key in obj1) {
      if (typeof obj2[key] === 'undefined') {
        result[key] = obj1[key];
      }
    }
    return result;
  }

  protected getFirstKey(obj: {}): string {
    for (const key in obj) {
      return key;
    }
    return '';
  }

  protected split(string: string, delimiter: string): string[] {
    const index = string.indexOf(delimiter);
    if (index === -1) {
      return [string, ''];
    }
    return [string.substr(0, index), string.substr(index + 1)];
  }

  protected explode(delimiter: string, string: string, limit?: number): string[] {
    //  discuss at: http://locutus.io/php/explode/
    // original by: Kevin van Zonneveld (http://kvz.io)
    //   example 1: explode(' ', 'Kevin van Zonneveld')
    //   returns 1: [ 'Kevin', 'van', 'Zonneveld' ]

    // Here we go...
    delimiter += '';
    string += '';

    const s = string.split(delimiter);

    if (typeof limit === 'undefined') return s;

    // Support for limit
    if (limit === 0) limit = 1;

    // Positive limit
    if (limit > 0) {
      if (limit >= s.length) {
        return s;
      }
      return s.slice(0, limit - 1).concat([s.slice(limit - 1).join(delimiter)]);
    }

    // Negative limit
    if (-limit >= s.length) {
      return [];
    }

    s.splice(s.length + limit);
    return s;
  }

  protected pluralize(string: string, count: number, suffix = 's') {
    return count === 1 ? string : string + suffix;
  }

  protected getConflictBranchName(name: string): string {
    return `${name}-gitsync-conflict`;
  }

  protected createProgressBar(total: number) {
    return new ProgressBar(':bar :current/:total :etas', {
      total,
      width: 50,
    });
  }

  private initContext() {
    this.context = {
      target: this.target,
      source: this.source,
      options: this.options,
      getTargetHash: this.getTargetHash.bind(this),
    };
  }

  private async runPlugin(name: string) {
    return await this.plugin.run(name, this.context);
  }

  private tickProgressBar(progressBar: ProgressBar) {
    if (npmlog.levels[npmlog.level] <= npmlog.levels.info) {
      progressBar.tick();
    }
  }

  private withPaths(args: string[], paths: string[]) {
    // Do not specify root directory, so that logs will contain *empty* commits (include merges)
    if (paths.length === 1 && paths[0] === './') {
      return args;
    }
    return args.concat(['--'].concat(paths));
  }

  private parseSquashMessage(message: string) {
    if (message.includes('chore(sync): squash commits from')) {
      const matches = /chore\(sync\): squash commits from (.+?) to (.+?)$/.exec(message);
      if (!matches) {
        log.debug(`Cannot parse squash revisions in message: ${message}`);
      }
      return matches;
    }
    return null;
  }

  private moveToFirst(array: any, element: any) {
    array.splice(array.indexOf(element), 1);
    array.unshift(element);
    return array;
  }

  private getPathDepth(path: string) {
    if (path === './') {
      return 1;
    }
    return path.split('/').length;
  }
}

export default Sync;
