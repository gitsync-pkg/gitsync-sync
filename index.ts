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
import {promises as fsp} from 'fs';
import * as multimatch from 'multimatch';

const unlink = util.promisify(fs.unlink);
const mkdir = util.promisify(fs.mkdir);
const rename = util.promisify(fs.rename);

export interface SyncArguments extends Arguments {
  target: string
  sourceDir: string
  targetDir?: string
  includeBranches?: string | string[],
  excludeBranches?: string | string[],
  includeTags?: string | string[],
  excludeTags?: string | string[],
  after?: string,
  maxCount?: number,
  preserveCommit?: boolean,
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
  private initHash: string;
  private source: Git;
  private target: Git;
  private argv: SyncArguments = {
    // TODO
    $0: '',
    _: [],
    target: '.',
    sourceDir: '',
    targetDir: '.',
    preserveCommit: true,
  };
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
  private workTree: Git;
  private conflictBranch: string;
  private config: Config;

  async sync(argv: SyncArguments) {
    this.config = new Config;

    Object.assign(this.argv, argv);
    this.source = await this.initRepo('.');
    this.target = await this.initRepo(this.argv.target);

    this.sourceDir = this.argv.sourceDir;
    this.targetDir = this.argv.targetDir;

    if (!fs.existsSync(this.sourceDir)) {
      throw new Error(`Directory "${this.sourceDir}" does not exist in current repository.`);
    }

    this.initHash = await this.target.run(['rev-list', '-n', '1', '--all']);
    try {
      const result = await this.syncCommits();
      if (!result) {
        // TODO
        throw new Error('conflict');
      }

      if (!argv.noTags) {
        await this.syncTags();
      }

      await this.clean();
      log.warn('Sync finished.');
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

    1. cd ${this.target.dir}/${this.targetDir}
    2. ${this.initHash ? 'git reset --hard ' + this.initHash : 'git rm --cached -r *'}
    ${!this.initHash ? '3. git update-ref -d HEAD' : ''}
`;

      log.warn(message);
      throw e;
    }
  }

  /**
   * Create repo instance from local directory or remote URL
   */
  protected async initRepo(repo: string) {
    // Load from existing dir
    if (await this.isDir(repo)) {
      const repoInstance = this.createGit(path.resolve(repo));
      const result = await repoInstance.run(['rev-parse', '--is-bare-repository']);
      if (result === 'false') {
        return repoInstance;
      }
    }

    // Clone from bare repo or remote url
    const repoDir = this.config.getBaseDir() + '/' + repo.replace(/[:@/\\]/g, '-');
    const repoInstance = this.createGit(repoDir);

    if (!fs.existsSync(repoDir)) {
      await fsp.mkdir(repoDir, {recursive: true});
      await repoInstance.run(['clone', repo, '.']);
    }

    return repoInstance;
  }

  protected async syncCommits() {
    const sourceBranches = await this.parseBranches(this.source);
    const targetBranches = await this.parseBranches(this.target);

    const sourceLogs = await this.getLogs(this.source, sourceBranches, this.sourceDir);
    const targetLogs = await this.getLogs(this.target, targetBranches, this.targetDir);

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

    // 找到当前仓库有,而目标仓库没有的记录
    const newLogs = this.objectValueDiff(sourceLogs, targetLogs);
    const newCount = _.size(newLogs);
    const sourceCount = _.size(sourceLogs);
    const targetCount = _.size(targetLogs);
    log.warn(
      `Commits: ${theme.info('new: %s, exists: %s, source: %s, target: %s')}`,
      newCount,
      sourceCount - newCount,
      sourceCount,
      targetCount,
    );

    const newBranches = this.objectValueDiff(sourceBranches, targetBranches);
    log.warn(
      `Branches: ${theme.info('new: %s, exists: %s, source: %s, target: %s')}`,
      _.size(newBranches),
      _.size(sourceBranches) - _.size(newBranches),
      _.size(sourceBranches),
      _.size(targetBranches)
    );

    this.isContains = sourceCount - targetCount === newCount;

    const progressBar = this.createProgressBar(newCount);
    const hashes = _.reverse(Object.keys(newLogs));
    for (let key in hashes) {
      await this.applyPatch(hashes[key]);
      progressBar.tick();
    }
    progressBar.terminate();

    log.warn(
      theme.info('Synced %s %s.'),
      newCount,
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

    if (!this.conflictBranches.length) {
      return true;
    }

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

    return !this.conflictBranches.length;
  }

  protected async syncBranches(sourceBranches: any, targetBranches: any) {
    let skipped = 0;
    const progressBar = this.createProgressBar(Object.keys(sourceBranches).length);

    for (let key in sourceBranches) {
      let sourceBranch: string = sourceBranches[key];
      let localBranch = this.toLocalBranch(sourceBranch);

      // 当前branch已经同步到最新
      if (localBranch === this.currentBranch) {
        progressBar.tick();
        continue;
      }

      if (!_.includes(targetBranches, sourceBranch)) {
        const result = await this.createOrUpdateTargetBranch(sourceBranch);
        if (!result) {
          skipped++;
        }
        progressBar.tick();
        continue;
      }

      const sourceHash = await this.source.run(['rev-parse', sourceBranch]);
      const targetHash = await this.findTargetTagHash(sourceHash);
      if (!targetHash) {
        skipped++;
        await this.logCommitNotFound(sourceHash, sourceBranch);
        progressBar.tick();
        continue;
      }

      const targetBranchHash = await this.target.run(['rev-parse', localBranch]);
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
      } else {
        localBranch = this.toLocalBranch(sourceBranch);
        await this.target.run(['branch', '-f', this.getConflictBranchName(localBranch), targetHash]);
        this.conflictBranches.push(localBranch);
      }
      progressBar.tick();
    }

    progressBar.terminate();
    log.warn(theme.info(`Synced ${_.size(sourceBranches) - skipped}, skipped ${skipped} branches.`));
  }

  protected async createOrUpdateTargetBranch(sourceBranch: string) {
    const sourceHash = await this.source.run(['rev-parse', sourceBranch]);
    const targetHash = await this.findTargetTagHash(sourceHash);
    if (targetHash) {
      await this.target.run(['branch', '-f', this.toLocalBranch(sourceBranch), targetHash]);
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
      this.sourceDir,
    ]);
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
      this.sourceDir,
    ];

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
        await this.handleConflict(hash, [hash + '^']);
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
        this.sourceDir,
      ]);

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
      } else {
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
    let result = '';
    for (let i in parents) {
      // TODO 换行不正确?
      result += await this.source.run([
        'diff-tree',
        '--name-status',
        '-r',
        parents[i],
        hash,
        '--',
        this.sourceDir,
      ], {
        trimEnd: false,
      }) + "\n";
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

    const files: StringStringMap = this.parseChangedFiles(result);

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
    const tempDir = this.target.dir + '/.git/git-sync';
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
      unlink(targetFullDir + '/' + file.substr(removeLength));
    });

    for (let key in updateFiles) {
      let file = updateFiles[key];
      let target = targetFullDir + '/' + file.substr(removeLength);
      let dir = path.dirname(target);
      if (!fs.existsSync(dir)) {
        await mkdir(path.dirname(target));
      }
      await rename(tempDir + '/' + file, target);
    }
  }

  protected parseChangedFiles(result: string) {
    const files: StringStringMap = {};

    result.trimRight().split("\n").forEach((line: string) => {
      const [status, file] = line.split("\t");
      files[file] = status.substr(0, 1);
    });

    return files;
  }

  protected async getWorkTree(repo: Git, tempDir: string) {
    if (!this.workTree) {
      await repo.run(['worktree', 'add', '-f', tempDir, '--no-checkout', '--detach']);
      this.workTree = this.createGit(tempDir);
    }
    return this.workTree;
  }

  protected async syncTags() {
    const sourceTags = await this.getTags(this.source);
    const targetTags = await this.getTags(this.target);

    const newTags: Tags = this.keyDiff(sourceTags, targetTags);
    const filterTags: Tags = this.filterObjectKey(newTags, this.argv.includeTags, this.argv.excludeTags);

    const total = _.size(sourceTags);
    const newCount = _.size(newTags);
    const filteredCount = _.size(filterTags);
    log.warn(`Tags: ${theme.info(`new: ${filteredCount}, exists: ${total - newCount}, source: ${total}, target: ${_.size(targetTags)}`)}`);

    let skipped = 0;
    const progressBar = this.createProgressBar(newCount);
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
        progressBar.tick();
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
      progressBar.tick();
    }

    progressBar.terminate();
    log.warn(theme.info(`Synced ${filteredCount - skipped}, skipped ${skipped} tags.`));
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
      '--format=%ct %B',
      '-1',
      hash,
    ]);

    let [date, message] = this.split(log, ' ');
    if (message.includes("\n")) {
      message = this.split(message, "\n")[0];
    }

    // Here we assume that a person will not commit the same message in the same second.
    // This is the core logic to sync commits between two repositories.
    //
    // Target repository may not have any commits, so we mute the error.
    const target = await this.target.run([
      'log',
      '--after=' + date,
      '--before=' + date,
      '--grep',
      message,
      '--fixed-strings',
      '--format=%H',
      '--all', // TODO search in $toBranches
    ], {
      mute: true,
    });

    if (target.includes("\n")) {
      throw new Error(`Expected to return one commit, but returned more than one commit with the same message in the same second, commit date: ${date}, message: ${message}: hashes: ${target}`);
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
    await this.target.run(['add', '-A']);

    const commit = await this.source.run(['show', '-s', '--format=%an|%ae|%ai|%cn|%ce|%ci|%B', hash]);
    // TODO split
    const parts: string[] = this.explode('|', commit, 7);
    await this.target.run([
        'commit',
        '--allow-empty',
        '-am',
        parts[6],
      ], {
        env: this.argv.preserveCommit ? {
          GIT_AUTHOR_NAME: parts[0],
          GIT_AUTHOR_EMAIL: parts[1],
          GIT_AUTHOR_DATE: parts[2],
          GIT_COMMITTER_NAME: parts[3],
          GIT_COMMITTER_EMAIL: parts[4],
          GIT_COMMITTER_DATE: parts[5],
        } : {}
      }
    );
  }

  protected async handleConflict(hash: string, parents: string[]) {
    if (this.isContains) {
      await this.overwrite(hash, parents);
    } else {
      await this.syncToConflictBranch(hash);
    }
  }

  protected async getLogs(repo: Git, branches: string[], path: string): Promise<StringStringMap> {
    // Check if the repo has commit, because "log" will return error code 128
    // with message "fatal: your current branch 'master' does not have any commits yet" when no commits
    if (!await repo.run(['rev-list', '-n', '1', '--all'])) {
      return {};
    }

    let args = [
      'log',
      '--graph',
      '--format=#%H %P-%at %s',
    ];

    if (this.argv.after) {
      args = args.concat([
        '--after',
        this.argv.after
      ]);
    }

    if (this.argv.maxCount) {
      args.push('-' + this.argv.maxCount);
    }

    if (branches.length) {
      args = args.concat(branches);
    } else {
      args.push('--all');
    }

    if (path) {
      args = args.concat([
        '--',
        path
      ]);
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

      const [hash, detail] = row.split('-', 2);
      logs[hash] = detail;
    });
    return logs;
  }

  protected async parseBranches(repo: Git) {
    const repoBranches = await this.getBranches(repo);
    return this.filter(repoBranches, this.argv.includeBranches, this.argv.excludeBranches);
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
    return multimatch(array, patterns);
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

    const keys = multimatch(Object.keys(object), patterns);
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

    const result = await this.source.run([
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

  protected diff(arr1: any[], arr2: any[]) {
    return arr1.filter(x => !arr2.includes(x));
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

  protected intersect(arr1: string[], arr2: string[]) {
    return arr1.filter(x => arr2.includes(x));
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
    return name + '-git-sync-conflict';
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

  protected async isDir(dir: string) {
    try {
      return (await fsp.stat(dir)).isDirectory();
    } catch (e) {
      return false;
    }
  }

  protected createGit(dir: string) {
    return git(dir, {
      logger: log
    });
  }
}

export default Sync;
