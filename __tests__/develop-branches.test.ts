import * as path from 'path';
import {
  changeDir,
  resetDir,
  clearMessage,
  createRepo, catchError
} from '@gitsync/test';
import Sync, {SyncOptions} from "..";
import {Git} from "git-cli-wrapper";
import log from '@gitsync/log';

const sync = async (source: Git, options: SyncOptions, instance: Sync = null) => {
  changeDir(source);
  const sync = instance || new Sync();
  options.yes = true;
  await sync.sync(options);
  resetDir();
};

describe('develop branches option', () => {
  afterEach(() => {
    clearMessage();
  });

  test('basic', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    await source.run(['checkout', '-b', 'develop']);
    await source.commitFile('test2.txt');

    const target = await createRepo();
    const targetDir = path.resolve(target.dir);
    await sync(source, {
      target: targetDir,
      sourceDir: '.',
      developBranches: ['develop'],
    });
    expect(await target.run(['log', '-n', '1', 'develop'])).toContain('add test2.txt');

    // Remove the last commit
    await source.run(['reset', '--hard', 'HEAD~1']);

    await sync(source, {
      target: targetDir,
      sourceDir: '.',
      developBranches: ['develop'],
    });

    // Re-sync without the last commit
    expect(await target.run(['log', '-n', '1', 'develop'])).toContain('add test.txt');
  });

  test('branch is checked out error', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    const target = await createRepo();
    const targetDir = path.resolve(target.dir);

    const error = await catchError(async () => {
      await sync(source, {
        target: targetDir,
        sourceDir: '.',
        developBranches: ['master'],
      });
    });

    expect(error).toEqual(new Error('Cannot delete develop branch "master" checked out in target repository.'));
  });

  test('branch will be add back', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    await source.run(['checkout', '-b', 'develop']);
    await source.commitFile('test2.txt');

    const target = await createRepo();
    const targetDir = path.resolve(target.dir);
    await sync(source, {
      target: targetDir,
      sourceDir: '.',
      developBranches: ['develop'],
    });

    await source.run(['checkout', 'master']);
    await source.commitFile('test3.txt');
    await sync(source, {
      target: targetDir,
      sourceDir: '.',
      developBranches: ['develop'],
    });

    expect(await target.run(['branch'])).toContain('develop');
  });
});
