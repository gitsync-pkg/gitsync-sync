import {Arguments} from "yargs";
import git, {Git} from 'git-cli-wrapper';
import log from '@gitsync/log';
import {Config} from '@gitsync/config';
import theme from 'chalk-theme';
import * as _ from 'lodash';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import * as npmlog from "npmlog";
import * as ProgressBar from 'progress';
import * as micromatch from 'micromatch';
import * as inquirer from 'inquirer';

const unlink = util.promisify(fs.unlink);
const mkdir = util.promisify(fs.mkdir);
const rename = util.promisify(fs.rename);

export interface SyncOptions {
  target: string
  sourceDir: string
  targetDir?: string
  includeBranches?: string | string[],
  excludeBranches?: string | string[],
  includeTags?: string | string[],
  excludeTags?: string | string[],
  noTags?: boolean,
  after?: number | string,
  maxCount?: number,
  preserveCommit?: boolean,
  yes?: boolean,
  addTagPrefix?: string,
  removeTagPrefix?: string,
  filter?: string[],
}

export interface SyncArguments extends Arguments<SyncOptions> {

}

export interface Tag {
  hash: string
  annotated: boolean
}

export interface Tags {
  [key: string]: Tag;
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
  };
  private initHash: string;
  private source: Git;
  private target: Git;
  private sourceDir: string;
  private targetDir: string;
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
  private env: StringStringMap;
  private sourcePaths: string[] = [];
  private targetPaths: string[] = [];

  async sync(options: SyncOptions) {
    this.config = new Config;
    this.prepareOptions(options);

    this.source = git('.');

    this.target = git(await this.config.getRepoDirByRepo(this.options, true));
    if (await this.target.run(['status', '--short'])) {
      throw new Error(`Target repository "${this.target.dir}" has uncommitted changes, please commit or remove changes before syncing.`);
    }

    this.sourceDir = this.options.sourceDir;
    this.targetDir = this.options.targetDir;

    // TODO move to prepareOptions
    this.options.sourceDir = path.normalize(this.options.sourceDir + '/');
    this.options.targetDir = path.normalize(this.options.targetDir + '/');

    // @link https://git-scm.com/docs/gitglossary#Documentation/gitglossary.txt-aiddefpathspecapathspec
    const regex = /^:(!|\^|\/|\([a-z,]+\))(.+?)$/;
    this.options.filter.forEach(pathSpec => {
      let pathPrefix = '';
      let pathSuffix = '';

      if (pathSpec.substr(0, 1) === ':') {
        const matches = regex.exec(pathSpec);
        if (matches) {
          pathPrefix = ':' + matches[1];
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
        GITSYNC_UPDATE: process.env.GITSYNC_UPDATE
      }
    }

    this.initHash = await this.target.run(['rev-list', '-n', '1', '--all']);
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
    2. ${this.initHash ? 'git reset --hard ' + this.initHash : 'git rm --cached -r *'}
    ${!this.initHash ? '3. git update-ref -d HEAD' : ''}
`;

      log.error(message);
      throw e;
    }
  }

  private prepareOptions(options: SyncOptions) {
    Object.assign(this.options, options);
    this.options.filter = this.toArray(this.options.filter);
  }

  protected async syncCommits() {
    const sourceBranches = await this.parseBranches(this.source);
    const targetBranches = await this.parseBranches(this.target);

    const sourceLogs = await this.getLogs(this.source, sourceBranches, this.sourcePaths);
    const targetLogs = await this.getLogs(this.target, targetBranches, this.targetPaths);

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
      theme.info(_.size(targetBranches).toString())
    );

    this.isContains = sourceCount - targetCount === newCount;
    log.debug(`source repository ${this.isContains ? 'contains' : 'does not contain'} target repostitory`);

    let filteredTags;
    if (!this.options.noTags) {
      filteredTags = await this.getFilteredTags();
    }

    if (!this.options.yes) {
      const {toSync} = await inquirer.prompt([{
        type: 'confirm',
        name: 'toSync',
        message: 'Are you sure to sync?',
        default: false
      }]);
      if (!toSync) {
        return;
      }
    }

    const branch = await this.getBranchFromLog(sourceLogs);
    this.currentBranch = this.defaultBranch = this.toLocalBranch(branch);

    const targetBranch = await this.target.getBranch();
    this.origBranch = targetBranch;

    if (this.currentBranch && targetBranch !== this.defaultBranch) {
      if (!targetBranches.includes(this.defaultBranch)) {
        await this.target.run(['checkout', '-b', this.defaultBranch]);
      } else {
        await this.target.run(['checkout', this.defaultBranch]);
      }
    }

    const progressBar = this.createProgressBar(newCount);
    const hashes = _.reverse(Object.keys(newLogs));
    for (let key in hashes) {
      await this.applyPatch(hashes[key]);
      this.tickProgressBar(progressBar)
    }

    log.info(
      'Synced %s %s.',
      theme.info(newCount.toString()),
      this.pluralize('commit', newCount)
    );

    await this.syncBranches(sourceBranches, targetBranches);

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
        branchTips += '    ' + theme.info(branch) + ' conflict with ' + theme.info(this.getConflictBranchName(branch)) + "\n";
      });

      const branchCount = _.size(this.conflictBranches);
      log.warn(`
The target repository contains conflict ${this.pluralize('branch', branchCount, 'es')}, which need to be resolved manually.

The conflict ${this.pluralize('branch', branchCount, 'es')}:

${branchTips}
Please follow the steps to resolve the conflicts:

    1. cd ${this.target.dir}/${this.targetDir}
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

  private async getFilteredTags() {
    const sourceTags = await this.getTags(this.source);
    const targetTags = await this.getTags(this.target);

    const newTags: Tags = this.keyDiff(sourceTags, targetTags);

    let include = this.options.includeTags;
    if (this.options.removeTagPrefix) {
      include = this.toArray(include);
      include.push(this.options.removeTagPrefix + '*');
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
      theme.info(_.size(targetTags).toString())
    );
    return filterTags;
  }

  private transformTagKey(tags: Tags, removeTagPrefix: string, addTagPrefix: string) {
    if (!removeTagPrefix && !addTagPrefix) {
      return tags;
    }

    let newTags: Tags = {};
    Object.keys(tags).forEach((tag: string) => {
      const newTag = addTagPrefix + tag.substring(removeTagPrefix.length);
      newTags[newTag] = tags[tag];
    });

    return newTags;
  }

  private async filterEmptyLogs(logs: StringStringMap) {
    const newLogs: StringStringMap = {};
    for (let hash in logs) {
      let fullHash = hash;

      hash = this.split(hash, '#')[1];
      let parent: string;
      [hash, parent] = this.split(hash, ' ');

      const targetHash = await this.getTargetHash(hash);
      if (!targetHash) {
        newLogs[fullHash] = logs[fullHash];
        continue;
      }

      let result = await this.target.run([
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        targetHash,
      ]);
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

    for (let key in sourceBranches) {
      let sourceBranch: string = sourceBranches[key];
      let localBranch = this.toLocalBranch(sourceBranch);

      if (!_.includes(targetBranches, sourceBranch)) {
        const result = await this.createOrUpdateTargetBranch(sourceBranch);
        if (!result) {
          skipped++;
        }
        this.tickProgressBar(progressBar)
        continue;
      }

      const sourceHash = await this.source.run(['rev-parse', sourceBranch]);
      const targetHash = await this.findTargetTagHash(sourceHash);
      if (!targetHash) {
        skipped++;
        await this.logCommitNotFound(sourceHash, sourceBranch);
        this.tickProgressBar(progressBar)
        continue;
      }

      const targetBranchHash = await this.target.run(['rev-parse', localBranch]);
      if (targetBranchHash === targetHash) {
        log.debug(`Branch "${localBranch}" is up to date, skipping`);
        this.tickProgressBar(progressBar)
        continue;
      }

      const result = await this.target.run([
        'merge-base',
        targetBranchHash,
        targetHash,
      ]);

      if (result === targetBranchHash) {
        // 新的分支包含老的，说明没有冲突，直接更新老分支
        const branchResult = await this.createOrUpdateTargetBranch(sourceBranch);
        if (!branchResult) {
          skipped++;
        }
      } else if (result === targetHash) {
        // 目标分支有新的提交，不用处理
        this.tickProgressBar(progressBar)
        continue;
      } else {
        // or this.conflictBranches.includes(localBranch)
        if (localBranch === this.currentBranch) {
          this.tickProgressBar(progressBar)
          continue;
        }

        await this.target.run(['branch', '-f', this.getConflictBranchName(localBranch), targetHash]);
        this.conflictBranches.push(localBranch);
      }
      this.tickProgressBar(progressBar)
    }

    log.info(
      'Synced %s, skipped %s branches.',
      theme.info((_.size(sourceBranches) - skipped).toString()),
      theme.info(skipped.toString())
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
          log.info('Target repository has commits that have not been sync back to source repository, ' +
            `do not update "${sourceBranch}" branch to avoid lost commits`);
        }
      } else {
        await this.target.run(['branch', '-f', sourceBranch, targetHash]);
      }

      return true;
    } else {
      await this.logCommitNotFound(sourceHash, sourceBranch);
      return false;
    }
  }

  protected async findTargetTagHash(sourceHash: string) {
    const sourceDirHash = await this.source.run([
      'log',
      '--format=%h',
      '-1',
      sourceHash,
      '--',
    ].concat(this.sourcePaths));
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
    const result = await this.source.run([
      'log',
      '--format=%ct %s',
      '-1',
      sourceHash,
    ]);
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
    } else {
      if (this.currentBranch !== this.defaultBranch) {
        await this.target.run(['checkout', this.defaultBranch]);
        this.currentBranch = this.defaultBranch;
      }
    }

    if (parents.length > 1) {
      await this.mergeParents(hash, parents);
      return;
    }

    // Create patch
    const args = [
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
      '--',
    ].concat(this.sourcePaths);

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
    patch += "\n\n";

    // Apply patch
    let patchArgs = [
      'apply',
      '-3',
      // @see \GitSyncTest\Command\SyncCommandTest::testApplySuccessWhenChangedLineEndings
      '--ignore-whitespace',
    ];

    if (this.sourceDir && this.sourceDir !== '.') {
      patchArgs.push('-p' + (this.strCount(this.sourceDir, '/') + 2));
    }

    if (this.targetDir && this.targetDir !== '.') {
      patchArgs = patchArgs.concat([
        '--directory',
        this.targetDir,
      ]);
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
        } else {
          await this.syncToConflictBranch(hash);
        }
      }
    }

    await this.commit(hash);
    this.setTargetHash(hash, await this.target.run(['rev-parse', 'HEAD']));
  }

  protected async syncToConflictBranch(hash: string) {
    await this.target.run(['checkout', '--theirs', '.']);

    if (!this.isConflict) {
      // 找到冲突前的记录，从这里开始创建branch
      const log = await this.source.run([
        'log',
        '--format=%ct %B',
        '-1',
        '--skip=1',
        hash,
        '--',
      ].concat(this.sourcePaths));

      let targetHash;
      if (log) {
        const [date, message] = this.explode(' ', log, 2);
        const shortMessage = this.explode("\n", message, 2)[0];
        targetHash = await this.target.run([
          'log',
          '--after=' + date,
          '--before=' + date,
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
      await this.target.run([
        'checkout',
        '-b',
        this.conflictBranch,
        targetHash,
      ]);
      this.isConflict = true;
      this.conflictBranches.push(branch);
    }
  }

  protected async overwrite(hash: string, parents: string[]) {
    let results = [];
    for (let i in parents) {
      let result = await this.source.run([
        'diff-tree',
        '--name-status',
        '-r',
        parents[i],
        hash,
        '--',
      ].concat(this.sourcePaths));
      if (result) {
        results.push(result);
      }
    }
    // Ignore empty commit
    if (!results.length) {
      return;
    }

    // TODO normalize
    let sourceDir = this.sourceDir;
    if (this.sourceDir === '.') {
      sourceDir = '';
    }

    let removeLength: number;
    if (sourceDir) {
      removeLength = sourceDir.length + 1;
    } else {
      removeLength = 0;
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
    const tempDir = this.target.dir + '/.git/gitsync-worktree';
    const workTree = await this.getWorkTree(this.source, tempDir);
    await workTree.run([
      'checkout',
      '-f',
      hash,
      '--',
    ].concat(updateFiles));

    const targetFullDir = this.target.dir + '/' + this.targetDir;

    // Delete first and then update, so that when the change is renamed,
    // ensure that the file will not be deleted.
    removeFiles.forEach((file) => {
      const targetFile = targetFullDir + '/' + file.substr(removeLength);
      if (fs.existsSync(targetFile)) {
        unlink(targetFile);
      }
    });

    let targetFiles = [];
    for (let key in updateFiles) {
      let file = updateFiles[key];
      let targetFile = file.substr(removeLength);

      targetFiles.push(path.join(this.targetDir, targetFile));
      let target = targetFullDir + '/' + targetFile;

      let dir = path.dirname(target);
      if (!fs.existsSync(dir)) {
        await mkdir(path.dirname(target));
      }
      await rename(tempDir + '/' + file, target);
    }

    await this.target.run(['add'].concat(targetFiles));
  }

  protected parseChangedFiles(result: string) {
    const files: StringStringMap = {};

    result.trim().split("\n").forEach((line: string) => {
      const [status, file] = line.split("\t");
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
    for (let name in filterTags) {
      let tag: Tag = filterTags[name];
      const targetHash = await this.findTargetTagHash(tag.hash);
      if (!targetHash) {
        const result = await this.source.run([
          'log',
          '--format=%ct %s',
          '-1',
          tag.hash,
        ]);
        const [date, message] = this.explode(' ', result, 2);

        log.warn(`Commit not found in target repository, tag: ${name}, date: ${date}, subject: ${message}`)
        skipped++;
        this.tickProgressBar(progressBar)
        continue;
      }

      // 如果有annotation，同步过去
      const args = [
        'tag',
        name,
        targetHash,
      ];
      if (tag.annotated) {
        args.push('-m');
        args.push(await this.source.run([
          'tag',
          '-l',
          '--format=%(contents)',
          name,
        ]));
      }
      await this.target.run(args);
      this.tickProgressBar(progressBar)
    }

    log.info(
      'Synced %s, skipped %s tags.',
      theme.info((filteredCount - skipped).toString()),
      theme.info(skipped.toString())
    );
  }

  protected async getTags(repo: Git) {
    // Check if the repo has tag, because "show-ref" will return error code 1 when no tags
    if (!await repo.run(['rev-list', '-n', '1', '--tags'])) {
      return {};
    }

    const tags: Record<string, Tag> = {};
    const output = await repo.run(['show-ref', '--tags', '-d']);

    // Example: ada25d8079f998939893a9ec33f4006d99a19554 refs/tags/v1.2.0^{}
    const regex = /^(.+?) refs\/tags\/(.+?)(\^\{\})?$/;
    output.split("\n").forEach((row: string) => {
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
    const name = 'sync-' + branch;
    await this.target.run(['checkout',
      '-B',
      name,
      await this.getTargetHash(branch),
    ]);
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
    const log = await this.source.run([
      'log',
      '--format=%ct %at %B',
      '-1',
      hash,
    ]);

    let [committerDate, authorDate, message] = this.explode(' ', log, 3);
    if (message.includes("\n")) {
      message = this.split(message, "\n")[0];
    }

    // Here we assume that a person will not commit the same message in the same second.
    // This is the core logic to sync commits between two repositories.
    let target = await this.target.run([
      'log',
      '--after=' + committerDate,
      '--before=' + committerDate,
      '--grep',
      message,
      '--fixed-strings',
      '--format=%H',
      '--all',
    ], {
      // Target repository may not have any commits, so we mute the error.
      mute: true,
    });

    if (!target || target.includes("\n")) {
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
      const logs = await this.target.run([
        'log',
        '--grep',
        message,
        '--fixed-strings',
        '--format=%H %at',
        '--all',
      ], {
        mute: true,
      });
      const hashes: string[] = [];
      logs.split('\n').forEach((log) => {
        const [hash, date] = log.split(' ');
        if (date === authorDate) {
          hashes.push(hash);
        }
      });
      target = hashes.join('\n');
    }

    if (target.includes("\n")) {
      throw new Error(`Expected to return one commit, but returned more than one commit with the same message in the same second, committer date: ${committerDate}, message: ${message}: hashes: ${target}`);
    }

    this.targetHashes[hash] = target;
    return target;
  }

  protected async mergeParents(hash: string, parents: string[]) {
    let args = [
      'merge',
      '--no-ff',
      // File may be changed after merging (no matter success or fail), before committing，
      // so we should stop, overwrite files to make sure files up to date, then commit.
      '--no-commit',
    ];

    for (let i in parents) {
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

    const commit = await this.source.run(['show', '-s', '--format=%an|%ae|%ai|%cn|%ce|%ci|%B', hash]);
    // TODO split
    const parts: string[] = this.explode('|', commit, 7);
    await this.target.run([
        'commit',
        '--allow-empty',
        '-am',
        parts[6],
      ], {
        env: Object.assign(this.options.preserveCommit ? {
          GIT_AUTHOR_NAME: parts[0],
          GIT_AUTHOR_EMAIL: parts[1],
          GIT_AUTHOR_DATE: parts[2],
          GIT_COMMITTER_NAME: parts[3],
          GIT_COMMITTER_EMAIL: parts[4],
          GIT_COMMITTER_DATE: parts[5]
        } : {}, this.env)
      }
    );
  }

  protected async handleConflict(hash: string, parents: string[]) {
    if (this.isContains && !this.isHistorical) {
      await this.overwrite(hash, parents);
    } else {
      await this.syncToConflictBranch(hash);
    }
  }

  protected async getLogs(repo: Git, branches: string[], paths: string[]): Promise<StringStringMap> {
    // Check if the repo has commit, because "log" will return error code 128
    // with message "fatal: your current branch 'master' does not have any commits yet" when no commits
    if (!await repo.run(['rev-list', '-n', '1', '--all'])) {
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
      args = args.concat([
        '--after',
        this.options.after.toString()
      ]);
    }

    if (this.options.maxCount) {
      args.push('-' + this.options.maxCount);
    }

    if (branches.length) {
      args = args.concat(branches);
    } else {
      args.push('--all');
    }

    // Do not specify root directory, so that logs will contain *empty* commits (include merges)
    if (paths.join() !== './') {
      args = args.concat(['--'].concat(paths));
    }

    let log = await repo.run(args);
    if (!log) {
      return {};
    }

    let logs: StringStringMap = {};
    log.split("\n").forEach((row: string) => {
      if (!row.includes('*')) {
        return;
      }

      const [hash, detail] = this.split(row, '-');
      logs[hash] = detail;
    });
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
      throw new Error(`Repository "${repo.dir}" has unmerged conflict branches "${conflicts.join(', ')}", please merge or remove branches before syncing.`);
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

    let patterns = include.concat(exclude.map(item => '!' + item));
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

    let patterns = include.concat(exclude.map(item => '!' + item));
    if (include.length === 0) {
      patterns.unshift('**');
    }

    const keys = micromatch(Object.keys(object), patterns);
    return keys.reduce((newObject: Record<string, any>, key: string) => {
      newObject[key] = object[key];
      return newObject;
    }, {})
  }

  protected async getBranches(repo: Git) {
    let result = await repo.run(['branch', '-a']);
    if (!result) {
      return [];
    }

    let branches: string[] = [];
    result.split("\n").forEach((name: string) => {
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

  protected async getBranchFromLog(logs: StringStringMap) {
    let log = this.getFirstKey(logs)
    if (!log) {
      return '';
    }

    log = this.split(log, '#')[1];
    const hash = this.split(log, ' ')[0];

    let result = await this.source.log([
      '--format=%D',
      '-1',
      hash,
    ]);
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

    result = await this.source.run([
      'branch',
      '--no-color',
      '--contains',
      hash,
    ]);
    // Example: * master
    let branch = this.split(result, "\n")[0];
    return branch.substr(2);
  }

  protected toLocalBranch(branch: string) {
    if (branch.startsWith('origin/')) {
      return branch.substr(7);
    }
    return branch;
  }

  protected objectValueDiff(obj1: any, obj2: any): {} {
    let result: any = {};
    for (let key in obj1) {
      if (!_.includes(obj2, obj1[key])) {
        result[key] = obj1[key];
      }
    }
    return result;
  }

  protected keyDiff(obj1: any, obj2: any) {
    let result: any = {};
    for (let key in obj1) {
      if (typeof obj2[key] === 'undefined') {
        result[key] = obj1[key];
      }
    }
    return result;
  }

  protected getFirstKey(obj: {}): string {
    for (let key in obj) {
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
    delimiter += ''
    string += ''

    var s = string.split(delimiter)

    if (typeof limit === 'undefined') return s

    // Support for limit
    if (limit === 0) limit = 1

    // Positive limit
    if (limit > 0) {
      if (limit >= s.length) {
        return s
      }
      return s
        .slice(0, limit - 1)
        .concat([s.slice(limit - 1)
          .join(delimiter)
        ])
    }

    // Negative limit
    if (-limit >= s.length) {
      return []
    }

    s.splice(s.length + limit)
    return s;
  }

  protected pluralize(string: string, count: number, suffix: string = 's') {
    return count === 1 ? string : (string + suffix);
  }

  protected getConflictBranchName(name: string): string {
    return name + '-gitsync-conflict';
  }

  protected strCount(string: string, search: string) {
    return string.split(search).length - 1
  }

  protected createProgressBar(total: number) {
    return new ProgressBar(':bar :current/:total :etas', {
      total: total,
      width: 50,
    });
  }

  private tickProgressBar(progressBar: ProgressBar) {
    if (npmlog.levels[npmlog.level] <= npmlog.levels.info) {
      progressBar.tick();
    }
  }
}

export default Sync;
