import * as fs from 'fs';
import * as npmlog from 'npmlog';
import * as path from 'path';
import * as util from 'util';
import {
  createRepo,
  removeRepos,
  logMessage,
  changeDir,
  resetDir,
  catchError,
  clearMessage
} from '@gitsync/test';
import Sync from "../index";
import git, {Git} from "git-cli-wrapper";
import {Config} from "@gitsync/config";
import log from '@gitsync/log';

const sync = async (source: Git, options: any, instance: Sync = null) => {
  changeDir(source);
  const sync = instance || new Sync();
  await sync.sync(Object.assign({
    // TODO
    $0: '',
    _: [],
  }, options));
  resetDir();
};

afterAll(() => {
  removeRepos();
});

afterEach(() => {
  clearMessage();
})

describe('sync command', () => {
  test('sync commits', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    const target = await createRepo();
    const targetDir = path.resolve(target.dir);

    await sync(source, {
      target: targetDir,
      sourceDir: '.',
    });

    const message = logMessage();
    expect(message).toContain('Commits: new: 1, exists: 0, source: 1, target: 0');
    expect(message).toContain('Synced 1 commit.');
    expect(fs.existsSync(target.getFile('test.txt'))).toBe(true);

    await sync(source, {
      target: targetDir,
      sourceDir: '.',
    });

    const message2 = logMessage();
    expect(message2).toContain('Commits: new: 0, exists: 1, source: 1, target: 1');
    expect(message2).toContain('Synced 0 commits.');
  });

  test('sync tags', async () => {
    const source = await createRepo();

    await source.commitFile('test.txt');
    await source.run(['tag', '1.0.0']);

    await source.commitFile('test2.txt');
    await source.run(['tag', '-m', 'Annotated tag', '1.0.1']);

    const target = await createRepo();

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    const message = logMessage();

    expect(message).toContain('Tags: new: 2, exists: 0, source: 2, target: 0');
    expect(message).toContain('Synced 2, skipped 0 tags.');

    const tags = await target.run(['tag', '-l', '-n99']);
    expect(tags).toContain('1.0.0           add test.txt');
    expect(tags).toContain('1.0.1           Annotated tag');

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    const message2 = logMessage();
    expect(message2).toContain('Tags: new: 0, exists: 2, source: 2, target: 2');
    expect(message2).toContain('Synced 0, skipped 0 tags.');
  })

  test('no-tags option', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');
    await source.run(['tag', '1.0.0']);

    const target = await createRepo();

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      noTags: true,
    });

    expect(logMessage()).not.toContain('Synced 0, skipped 0 tags.');

    const tags = await target.run(['tag']);
    expect(tags).toBe('');
  });

  test('includeTags option', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');
    await source.run(['tag', '@test/api@0.1.0']);
    await source.run(['tag', '@test/log@0.1.0']);

    const target = await createRepo();

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      includeTags: [
        "@test/log@*"
      ],
    });

    const tags = await target.run(['tag']);
    expect(tags).toBe('@test/log@0.1.0');
  });

  test('excludeTags option', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');
    await source.run(['tag', '@test/api@0.1.0']);
    await source.run(['tag', '@test/log@0.1.0']);

    const target = await createRepo();

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      excludeTags: [
        "@test/log@*"
      ],
    });

    const tags = await target.run(['tag']);
    expect(tags).toBe('@test/api@0.1.0');
  });

  test('includeTags and excludeTags options', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');
    await Promise.all([
      source.run(['tag', '@test/log@0.1.0']),
      source.run(['tag', '@test/api@0.1.0']),
      source.run(['tag', '@test/test@0.1.0'])
    ]);

    const target = await createRepo();

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      includeTags: [
        '@test/log@*',
      ],
      excludeTags: [
        "@test/api@*"
      ],
    });

    const tags = await target.run(['tag']);
    expect(tags).toContain('@test/log@0.1.0');
    expect(tags).not.toContain('@test/test@0.1.0');
    expect(tags).not.toContain('@test/api@0.1.0');
  });

  test('sync tag not found', async () => {
    const source = await createRepo();
    await source.commitFile('text.txt');
    await source.run(['tag', '1.0.0']);

    await source.commitFile('package-name/test2.txt');
    await source.run(['tag', '1.0.1']);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: 'package-name'
    });

    const tags = await target.run(['tag', '-l']);
    expect(tags).toContain('1.0.1');
    expect(tags).not.toContain('1.0.0');
  });

  test('create tag that commit not in sync dir', async () => {
    const source = await createRepo();
    await source.commitFile('package-name/test.txt');
    await source.commitFile('test.txt');
    await source.run(['tag', '1.0.0']);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: 'package-name'
    });

    const message = logMessage();
    expect(message).toContain('Tags: new: 1, exists: 0, source: 1, target: 0');
    expect(message).toContain('Synced 1, skipped 0 tags.');

    const tags = await target.run(['tag']);
    expect(tags).toContain('1.0.0');
  });

  test('search commit message contains line break', async () => {
    const source = await createRepo();

    await source.commitFile('test.txt', 'test', "a\nb");

    const subject = await source.run(['log', '--format=%s']);
    expect(subject).toBe('a b');

    await source.run(['tag', '1.0.0']);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.'
    });

    const tags = await target.run(['tag', '-l']);
    expect(tags).toContain('1.0.0');
  });

  test('sourceDir argument', async () => {
    const source = await createRepo();
    await source.commitFile('package-name/package.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: 'package-name'
    });

    expect(fs.existsSync(target.getFile('package.txt'))).toBe(true);
  });

  test('targetDir argument', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name'
    });

    expect(fs.existsSync(target.getFile('package-name/test.txt'))).toBe(true);
  });

  test('includeBranches option', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('test2.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name',
      includeBranches: 'master',
    });

    expect(logMessage()).toContain('Branches: new: 1, exists: 0, source: 1, target: 0');
    expect(fs.existsSync(target.getFile('package-name/test.txt'))).toBeTruthy();
    expect(fs.existsSync(target.getFile('package-name/test2.txt'))).toBeFalsy();
  });

  test('excludeBranches option', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    await source.run(['checkout', '-b', 'feature/issue-1']);
    await source.commitFile('test2.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name',
      excludeBranches: 'feature/*',
    });

    expect(logMessage()).toContain('Branches: new: 1, exists: 0, source: 1, target: 0');
    expect(fs.existsSync(target.getFile('package-name/test.txt'))).toBeTruthy();
    expect(fs.existsSync(target.getFile('package-name/test2.txt'))).toBeFalsy();
  });

  test('sync custom branch', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    await source.run(['checkout', '-b', 'custom']);
    await source.commitFile('test2.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name',
      includeBranches: 'custom',
    });

    expect(logMessage()).toContain('Branches: new: 1, exists: 0, source: 1, target: 0');
    expect(fs.existsSync(target.getFile('package-name/test.txt'))).toBeTruthy();
    expect(fs.existsSync(target.getFile('package-name/test2.txt'))).toBeTruthy();

    expect(await target.getBranch()).toBe('custom');
  });

  test('sync multi branches', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('test2.txt');

    await source.run(['checkout', '-b', 'branch2']);
    await source.commitFile('test3.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name',
    });

    expect(logMessage()).toContain('Branches: new: 3, exists: 0, source: 3, target: 0');

    expect(await target.getBranch()).toBe('master');
    expect(fs.existsSync(target.getFile('package-name/test.txt'))).toBeTruthy();
    expect(fs.existsSync(target.getFile('package-name/test2.txt'))).toBeFalsy();
    expect(fs.existsSync(target.getFile('package-name/test3.txt'))).toBeFalsy();

    await target.run(['checkout', 'branch']);
    expect(fs.existsSync(target.getFile('package-name/test2.txt'))).toBeTruthy();

    await target.run(['checkout', 'branch2']);
    expect(fs.existsSync(target.getFile('package-name/test3.txt'))).toBeTruthy();
  });

  test('sync remote branch to local', async () => {
    const bare = await createRepo(true);
    const source = await createRepo();
    await source.run(['remote', 'add', 'origin', bare.dir]);

    await source.commitFile('test.txt');
    await source.run(['push', '-u', 'origin', 'master']);

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('test2.txt');
    await source.run(['push', '-u', 'origin', 'branch']);

    await source.run(['checkout', 'master']);
    await source.run(['branch', '-d', 'branch']);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name',
    });

    expect(await target.getBranch()).toBe('master');
    expect(await target.run(['log', '-n', '1', 'master'])).toContain('add test.txt');

    // Not origin/branch
    expect(await target.run(['branch', '-a'])).toContain('branch');
    expect(await target.run(['log', '-n', '1', 'branch'])).toContain('add test2.txt');
  });

  test('sync remote branch contains tags to local', async () => {
    const bare = await createRepo(true);
    const source = await createRepo();
    await source.run(['remote', 'add', 'origin', bare.dir]);

    await source.commitFile('test.txt');
    await source.run(['push', '-u', 'origin', 'master']);

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('test2.txt');

    // the commit contains tag and remote branch
    await source.run(['tag', '1.0.0']);
    await source.run(['push', '-u', 'origin', 'branch']);

    await source.run(['checkout', 'master']);
    await source.run(['branch', '-d', 'branch']);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name',
    });

    expect(await target.getBranch()).toBe('master');
    expect(await target.run(['log', '-n', '1', 'master'])).toContain('add test.txt');

    // Not origin/branch
    expect(await target.run(['branch', '-a'])).toContain('branch');
    expect(await target.run(['log', '-n', '1', 'branch'])).toContain('add test2.txt');
  });

  test('test sync existing branches', async () => {
    const source = await createRepo();
    await source.commitFile('master.txt');

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('branch.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    expect(logMessage()).toContain('Branches: new: 2, exists: 0, source: 2, target: 0');

    const result = await target.run(['branch']);
    expect(result).toContain('branch');
    expect(result).toContain('master');

    await source.commitFile('branch-2.txt');

    await source.run(['checkout', 'master']);
    await source.commitFile('master-2.txt');

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    expect(logMessage()).toContain('Branches: new: 0, exists: 2, source: 2, target: 2');

    expect(await target.getBranch()).toBe('master');
    expect(fs.existsSync(target.getFile('master-2.txt'))).toBeTruthy();
    expect(fs.existsSync(target.getFile('branch-2.txt'))).toBeFalsy();

    await target.run(['checkout', 'branch']);
    expect(fs.existsSync(target.getFile('master-2.txt'))).toBeFalsy();
    expect(fs.existsSync(target.getFile('branch-2.txt'))).toBeTruthy();
  });

  test('preserve-commit argument is true', async () => {
    const source = await createRepo();

    await source.run(['config', 'user.name', 'test']);
    await source.run(['config', 'user.email', 'test@test.com']);
    await source.commitFile('test.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: '.',
      preserveCommit: true,
    });

    const log = await target.run(['log', '-1', '--format=%cn %ce']);
    expect(log).toBe('test test@test.com');
  });

  test('preserve-commit argument is false', async () => {
    const source = await createRepo();

    await source.run(['config', 'user.name', 'test']);
    await source.run(['config', 'user.email', 'test@test.com']);
    await source.commitFile('test.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      preserveCommit: false,
    });

    const name = await target.run(['config', 'user.name']);
    const email = await target.run(['config', 'user.email']);
    const log = await target.run(['log', '-1', '--format=%cn %ce']);
    expect(name + ' ' + email).toBe(log);
  });

  test('after option', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      after: Math.floor(new Date().getTime() / 1000) + 1,
    });

    const message = logMessage();
    expect(message).toContain('Commits: new: 0, exists: 0, source: 0, target: 0');
    expect(message).toContain('Synced 0 commits.');

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      after: Math.floor(new Date().getTime() / 1000) - 1,
    });

    const message2 = logMessage();
    expect(message2).toContain('Commits: new: 1, exists: 0, source: 1, target: 0');
    expect(message2).toContain('Synced 1 commit.');
    expect(fs.existsSync(await target.getFile('test.txt'))).toBeTruthy();
  });

  test('max-count option', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');
    await source.commitFile('test2.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      maxCount: 1,
    });

    const message = logMessage();
    expect(message).toContain('Commits: new: 1, exists: 0, source: 1, target: 0');
    expect(message).toContain('Synced 1 commit.');

    expect(fs.existsSync(await target.getFile('test2.txt'))).toBeTruthy();
    expect(fs.existsSync(await target.getFile('test.txt'))).toBeFalsy();
  });

  test('sync will exclude file not in source dir', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');
    await source.commitFile('package-name/test2.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: 'package-name',
    });

    expect(fs.existsSync(await target.getFile('test2.txt'))).toBeTruthy();
    expect(fs.existsSync(await target.getFile('test.txt'))).toBeFalsy();
  });

  test('sync from empty repo wont cause error', async () => {
    const source = await createRepo();
    const target = await createRepo();

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    const files = await util.promisify(fs.readdir)(target.dir);
    expect(files).toEqual(['.git']);
  });

  test('allow not exist source dir', async () => {
    const source = await createRepo();
    const target = await createRepo();

    const noError = await catchError(async () => {
      return await sync(source, {
        target: target.dir,
        sourceDir: 'not-exist',
      });
    });
    expect(noError).toBeUndefined();
  });

  test('long commit body', async () => {
    const message = `Add file

      detail
      detail
      detail`;

    const source = await createRepo();
    await source.commitFile('test.txt', 'test', message);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    const tarlogMessage = await target.run(['log', '-1', '--format=%B']);
    expect(tarlogMessage).toBe(tarlogMessage);
  });

  /**
   * @link https://github.com/symfony/symfony/commit/e9a2c3d7538a2700aa40b2bec15ffb31d9180096
   */
  test('commit body contains diff', async () => {
    const message = `feature #30345 [Monolog] Added a way to configure the ConsoleFormatter from the ConsoleHandler (lyrixx)

This PR was merged into the 4.3-dev branch.

Discussion
----------

[Monolog] Added a way to configure the ConsoleFormatter from the ConsoleHandler

| Q             | A
| ------------- | ---
| Branch?       | master
| Bug fix?      | no
| New feature?  | yes
| BC breaks?    | no
| Deprecations? | no
| Tests pass?   | yes
| Fixed tickets | -
| License       | MIT
| Doc PR        |

see also https://github.com/symfony/monolog-bundle/pull/297

from that:
![image](https://user-images.githubusercontent.com/408368/53246085-f63ed380-36af-11e9-9bff-2e42f8af141c.png)

to that:
![image](https://user-images.githubusercontent.com/408368/53246115-0787e000-36b0-11e9-93ef-e47ed058adbf.png)

with some configuration:

\`\`\`yaml
diff --git a/config/packages/dev/monolog.yaml b/config/packages/dev/monolog.yaml
index b1998da..66ae2db 100644
--- a/config/packages/dev/monolog.yaml
+++ b/config/packages/dev/monolog.yaml
@@ -17,3 +17,6 @@ monolog:
             type: console
             process_psr_3_messages: false
             channels: ["!event", "!doctrine", "!console"]
+            console_formater_options:
+                format: "%%datetime%% %%start_tag%%%%level_name%%%%end_tag%% <comment>[%%channel%%]<comment/> %%message%%%%context%%\\n"
+                multiline: fals
\`\`\`

Commits
-------

5e494db04c [Monolog] Added a way to configure the ConsoleFormatter from the ConsoleHandler`;

    const source = await createRepo();
    await source.commitFile('test.txt', 'test', message);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    const log = await target.run(['log', '-1', '--format=%B']);
    expect(log).toBe(message);
  });

  /**
   * git apply a.patch -v
   *
   * Checking patch Xxx...
   * error: while searching for:
   * xxx
   * error: patch failed: Xxx:n
   * error: Xxx: patch does not apply
   *
   * @link https://github.com/symfony/symfony/commit/6764f91ce987a55e19489e42b85a87ebb0b6ead7#diff-8b2d85614be47f8b85897945da204bb3L1
   */
  test('apply will success when changed line endings', async () => {
    const source = await createRepo();
    await source.run(['config', 'core.autocrlf', 'false']);
    await source.commitFile('test.txt', "1\r\n2\r\n");
    await source.commitFile('test.txt', "1\n2\n", 'fix line endings');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    const content = fs.readFileSync(target.getFile('test.txt'), 'utf-8');
    expect(content).toBe("1\n2\n");
  });

  test('sync removed file', async () => {
    const file = 'test.txt';

    const source = await createRepo();
    await source.commitFile(file);

    await source.run(['rm', file]);
    await source.run(['commit', '-am', 'remove file ' + file]);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    expect(fs.existsSync(target.getFile(file))).toBeFalsy();
  });

  test('source contains target wont create branch', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt', 'initial content', 'init');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('test.txt', 'branch content');

    await source.run(['checkout', 'master']);
    await source.commitFile('test.txt', 'master content');

    try {
      await source.run(['merge', 'branch']);
    } catch (e) {
      // Ignore merge error
    }

    // Commit to resolve merge
    await source.commitFile('test.txt', 'merged content');

    // Source repository contains target repository, so conflict will be resolved and won't create conflict branch
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    expect(fs.readFileSync(target.getFile('test.txt'), 'utf-8')).toBe('merged content');

    const result = await target.run(['branch', '-l']);
    expect(result).not.toContain('-gitsync-conflict');
  });

  test('source not contains target will create branch', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt', 'initial content', 'init');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    // Generate conflict content
    await source.commitFile('test.txt', 'new content by from repo', 'update by from repo');
    await target.commitFile('test.txt', 'new content by to repo', 'update by to repo');

    await source.commitFile('test2.txt');

    // Source repository don't contain target repository, so conflict will not be resolved and created conflict branch
    let error;
    try {
      await sync(source, {
        target: target.dir,
        sourceDir: '.',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toEqual(new Error('conflict'));
    expect(logMessage()).toContain(`The target repository contains conflict branch, which need to be resolved manually.

The conflict branch:

    master conflict with master-gitsync-conflict

Please follow the steps to resolve the conflicts:

    1. cd ${target.dir}/.
    2. git checkout BRANCH-NAME // Replace BRANCH-NAME to your branch name
    3. git merge BRANCH-NAME-gitsync-conflict
    4. // Follow the tips to resolve the conflicts
    5. git branch -d BRANCH-NAME-gitsync-conflict // Remove temp branch
    6. "gitsync ..." to sync changes back to current repository`);

    expect(fs.readFileSync(target.getFile('test.txt'), 'utf-8')).toBe('new content by to repo');

    const result = await target.run(['branch', '-l']);
    expect(result).toContain('master-gitsync-conflict');

    await target.run(['checkout', 'master-gitsync-conflict']);
    expect(fs.readFileSync(target.getFile('test2.txt'), 'utf-8')).toBe('test2.txt');
  });

  test('resolve conflict and sync back to source repo', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt', 'final');

    const target = await createRepo();
    await target.commitFile('test.txt', 'be overwritten');

    // Sync "content" to target repository
    const error = await catchError(async () => {
      await sync(source, {
        target: target.dir,
        sourceDir: '.',
      });
    });
    expect(error).toEqual(new Error('conflict'));

    await target.run(['merge', 'master-gitsync-conflict']);
    await target.run(['branch', '-d', 'master-gitsync-conflict']);
    expect(fs.readFileSync(target.getFile('test.txt'), 'utf-8')).toBe('final');

    // Sync "commits" to source repository
    const error2 = await catchError(async () => {
      await sync(target, {
        target: source.dir,
        sourceDir: '.',
      });
    });
    expect(error2).toEqual(new Error('conflict'));

    await source.run(['merge', 'master-gitsync-conflict', '--no-ff', '--no-commit']);
    // Important!: two repositories should be consistent at the end, otherwise, it will be conflicted next time!
    await source.commitFile('test.txt', 'final', 'merge from target');
    await source.run(['branch', '-d', 'master-gitsync-conflict']);

    // Sync "merge" to target repository
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    // Both have 3 commits
    expect((await source.run(['log', '--oneline'])).match(/\n/g).length).toBe(2);
    expect((await target.run(['log', '--oneline'])).match(/\n/g).length).toBe(2);

    // Sync back wont cause conflict
    await sync(target, {
      target: source.dir,
      sourceDir: '.',
    });
  });

  test('sync change file when merge conflict', async () => {
    const source = await createRepo();
    await source.addFile('delete-after-merge.txt');
    await source.addFile('rename-after-merge.txt');
    await source.commitFile('both-modify-but-delete-after-merge.txt', "a");

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('both-modify-but-delete-after-merge.txt', "b");

    await source.run(['checkout', 'master']);
    await source.commitFile('both-modify-but-delete-after-merge.txt', "c");

    try {
      await source.run([
        'merge',
        'branch',
      ]);
    } catch (e) {
      // Ignore merge error
    }

    await source.run(['rm', 'delete-after-merge.txt', 'both-modify-but-delete-after-merge.txt']);
    await source.run(['mv', 'rename-after-merge.txt', 'Rename-after-merge.txt']);
    await source.addFile('add-after-merge.txt');
    await source.run(['commit', '-am', 'merge success']);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name'
    });

    const files = await util.promisify(fs.readdir)(target.getFile('package-name'));
    expect(files).not.toContain('delete-after-merge.txt');
    expect(files).toContain('Rename-after-merge.txt');
    expect(files).not.toContain('both-modify-but-delete-after-merge.txt');
    expect(files).toContain('add-after-merge.txt');
  });

  test('sync change file when merge success', async () => {
    const source = await createRepo();
    await source.addFile('delete-after-merge.txt');
    await source.addFile('rename-after-merge.txt');
    await source.addFile('chmod-after-merge.txt');
    await source.commitFile('modify-after-merge.txt', "a\n\nb");

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('modify-after-merge.txt', "a\n\nc");

    await source.run(['checkout', 'master']);
    await source.commitFile('modify-after-merge.txt', "c\n\nc");

    await source.run([
      'merge',
      '--no-ff',
      '--no-commit',
      'branch',
    ]);

    await source.run(['rm', 'delete-after-merge.txt']);
    await source.run(['mv', 'rename-after-merge.txt', 'Rename-after-merge.txt']);
    await source.addFile('modify-after-merge.txt', 'd');
    await source.addFile('add-after-merge.txt');
    await util.promisify(fs.chmod)(source.getFile('chmod-after-merge.txt'), 0o755);
    await source.run(['commit', '-am', 'merge success']);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name',
    });

    const files = await util.promisify(fs.readdir)(target.getFile('package-name'));
    expect(files).not.toContain('delete-after-merge.txt');
    expect(files).toContain('Rename-after-merge.txt');
    expect(files).toContain('modify-after-merge.txt');
    expect(files).toContain('add-after-merge.txt');
    expect(fs.readFileSync(target.getFile('package-name/modify-after-merge.txt'), 'utf-8')).toBe('d');

    const mode755 = await target.run(['ls-files', '-s', 'package-name/chmod-after-merge.txt']);
    expect(mode755.startsWith('100755')).toBeTruthy();

    // add-after-merge.txt will be tracked
    const status = await target.run(['ls-files', '.', '--exclude-standard', '--others']);
    expect(status).toEqual('');
  });

  test('merge more than two parents', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    await source.run(['checkout', '-b', 'parent1']);
    await source.commitFile('test.txt', 'parent1');

    await source.run(['checkout', '-b', 'parent2']);
    await source.commitFile('test.txt', 'parent2');

    await source.run(['checkout', 'master']);
    await source.commitFile('test.txt', 'master');

    try {
      await source.run(['merge', 'parent1', 'parent2']);
    } catch (e) {
      // Ignore merge error
    }

    await source.commitFile('text.txt', 'merged');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name',
    });

    expect(fs.existsSync(target.getFile('package-name/text.txt'))).toBeTruthy();
    expect(fs.readFileSync(target.getFile('package-name/text.txt'), 'utf-8')).toBe('merged');

    const branch = await target.run(['branch']);
    expect(branch).not.toContain('sync-');
  });

  test('merge file contains line ending', async () => {
    const source = await createRepo();
    const content = "test\n";
    await source.commitFile('test.txt', content);

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('test2.txt');

    await source.run(['checkout', 'master']);
    await source.run(['merge',
      'branch',
    ]);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      targetDir: 'package-name',
    });

    expect(fs.existsSync(target.getFile('package-name/test.txt'))).toBeTruthy();
    expect(fs.readFileSync(target.getFile('package-name/test.txt'), 'utf-8')).toBe(content);
  });

  test('sync error with new repo', async () => {
    const source = await createRepo();
    const target = await createRepo();

    const syncInstance = new Sync();

    // @ts-ignore
    const syncCommitsMethod = jest.spyOn(syncInstance, 'syncCommits').mockImplementation(() => {
      throw new Error('test');
    });

    let error = null;
    try {
      await sync(source, {
        target: target.dir,
        sourceDir: '.',
      }, syncInstance);
    } catch (e) {
      error = e;
    }

    expect(error).toEqual(new Error('test'));
    expect(syncCommitsMethod).toBeCalled();
    expect(logMessage()).toContain(`Sorry, an error occurred during sync.

To retry your command with verbose logs:

    1. YOUR-COMMAND --log-level=verbose

To reset to previous HEAD:

    1. cd ${target.dir}
    2. git rm --cached -r *
    3. git update-ref -d HEAD`);
  });

  test('sync error with rew repo with verbose log', async () => {
    const level = npmlog.level;
    // @ts-ignore
    npmlog.level = 'verbose';

    const source = await createRepo();
    const target = await createRepo();

    const syncInstance = new Sync();

    // @ts-ignore
    const syncCommitsMethod = jest.spyOn(syncInstance, 'syncCommits').mockImplementation(() => {
      throw new Error('test');
    });

    let error = null;
    try {
      await sync(source, {
        target: target.dir,
        sourceDir: '.',
      }, syncInstance);
    } catch (e) {
      error = e;
    }

    expect(error).toEqual(new Error('test'));
    expect(syncCommitsMethod).toBeCalled();
    expect(logMessage()).toContain(`Sorry, an error occurred during sync.

To reset to previous HEAD:

    1. cd ${target.dir}
    2. git rm --cached -r *
    3. git update-ref -d HEAD`);

    // @ts-ignore
    npmlog.level = level;
  });

  test('sync error with repo has commits', async () => {
    const source = await createRepo();
    const target = await createRepo();
    await target.commitFile('test.txt');

    const syncInstance = new Sync();

    // @ts-ignore
    const syncCommitsMethod = jest.spyOn(syncInstance, 'syncCommits').mockImplementation(() => {
      throw new Error('test');
    });

    let error = null;
    try {
      await sync(source, {
        target: target.dir,
        sourceDir: '.',
      }, syncInstance);
    } catch (e) {
      error = e;
    }

    expect(error).toEqual(new Error('test'));
    expect(syncCommitsMethod).toBeCalled();
    expect(logMessage()).toContain(`Sorry, an error occurred during sync.

To retry your command with verbose logs:

    1. YOUR-COMMAND --log-level=verbose

To reset to previous HEAD:

    1. cd ${target.dir}
    2. git reset --hard ${await target.run(['rev-list', '-n', '1', '--all'])}`);
  });

  test('change file name case', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');
    await source.run(['mv', 'test.txt', 'Test.txt']);
    await source.run(['commit', '-am', 'rename']);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    expect(fs.existsSync(target.getFile('Test.txt'))).toBeTruthy();
  });

  test('change file name case and file content', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt', 'old content');
    await source.run(['mv', 'test.txt', 'Test.txt']);

    fs.writeFileSync(source.getFile('Test.txt'), 'new content');
    await source.run(['commit', '-am', 'rename']);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    expect(fs.existsSync(target.getFile('Test.txt'))).toBeTruthy();
  });

  test('target is a repository', async () => {
    const config = new Config();
    const source = await createRepo();
    await source.commitFile('test.txt');

    const targetBare = await createRepo(true);
    const options = {
      target: targetBare.dir,
      sourceDir: '.',
    };
    await sync(source, options);

    expect(fs.existsSync(path.join(source.dir, await config.getRepoDirByRepo(options), 'test.txt'))).toBeTruthy();
  });

  test('change content then rename cause conflict', async () => {
    const source = await createRepo();
    await source.commitFile('package-name/test.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: 'package-name',
    });

    await source.commitFile('package-name/test.txt', 'changed content');
    await source.run(['mv', 'package-name', 'new-package-name']);
    await source.run(['commit', '-am', 'rename to new dir']);

    const error = await catchError(async () => {
      await sync(source, {
        target: target.dir,
        sourceDir: 'new-package-name',
      })
    });

    expect(error).toEqual(new Error('conflict'));
  });

  test('reserve file mode', async () => {
    const source = await createRepo();
    await source.addFile('644.txt');

    await source.addFile('755.txt');
    await util.promisify(fs.chmod)(source.getFile('755.txt'), 0o755);
    await source.run(['commit', '-am', 'add test.txt']);

    const target = await createRepo();

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    const mode644 = await target.run(['ls-files', '-s', '644.txt']);
    expect(mode644.startsWith('100644')).toBeTruthy();

    const mode755 = await target.run(['ls-files', '-s', '755.txt']);
    expect(mode755.startsWith('100755')).toBeTruthy();
  });

  test('remove work tree after sync', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt', 'initial');

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('test.txt', 'branch');

    await source.run(['checkout', 'master']);
    await source.commitFile('test.txt', 'master');

    try {
      await source.run(['merge', 'branch']);
    } catch (e) {
      // Ignore merge error
    }

    await source.commitFile('test.txt', 'merged');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    const workTree = await source.run(['worktree', 'list']);
    expect(workTree).not.toContain('detached HEAD');
  });

  test('update current branch to last commit', async () => {
    const source = await createRepo();
    const target = await createRepo();

    await source.commitFile('test.txt');
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('branch.txt');
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    await source.run(['checkout', 'master']);
    await source.run(['merge', 'branch']);

    // target master branch should sync to last commit
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    const log = await target.log(['--oneline', '-1']);
    expect(log).toContain('add branch.txt');
  });

  test('target has uncommitted changed cant sync', async () => {
    const source = await createRepo();
    const target = await createRepo();

    await target.addFile('test.txt');

    const error = await catchError(async () => {
      await sync(source, {
        target: target.dir,
        sourceDir: '.',
      });
    });

    expect(error).toEqual(new Error(`Target repository "${target.dir}" has uncommitted changes, please commit or remove changes before syncing.`));
  });

  test('repository has new commit wont create conflict branch', async () => {
    const source = await createRepo();
    await source.commitFile('package-name/test.txt');
    await source.run(['checkout', '-b', 'branch']);

    // new commit
    await source.commitFile('test2.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: 'package-name',
    });

    await sync(target, {
      target: source.dir,
      sourceDir: '.',
      targetDir: 'package-name',
    });
  });

  test('sync back wont reset source repository HEAD', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    await source.commitFile('test2.txt');
    await sync(target, {
      target: source.dir,
      sourceDir: '.',
    });

    const log = await source.run(['log', '--oneline', '-1']);
    expect(log).toContain('test2.txt');
  });

  test('sync back from directory wont reset source repository HEAD', async () => {
    const source = await createRepo();
    await source.commitFile('package-name/test.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: 'package-name',
    });

    await source.commitFile('test2.txt');
    await sync(target, {
      target: source.dir,
      sourceDir: '.',
      targetDir: 'package-name',
    });

    const log = await source.run(['log', '--oneline', '-1']);
    expect(log).toContain('test2.txt');
  });

  test('sync back from branch wont reset source repository HEAD', async () => {
    const source = await createRepo();
    await source.commitFile('package-name/test.txt');

    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('package-name/test2.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: 'package-name',
    });

    await source.commitFile('test3.txt');

    await sync(target, {
      target: source.dir,
      sourceDir: '.',
      targetDir: 'package-name',
    });

    expect(await source.log(['--oneline', '-1'])).toContain('test3.txt');
  });

  test('commit will ignore untracked files', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt', 'initial content', 'init');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    // Generate conflict content
    await source.commitFile('test.txt', 'new content by from repo', 'update by from repo');
    await target.commitFile('test.txt', 'new content by to repo', 'update by to repo');

    // Important!: file will change from ignored to untracked when target repository checkout branch from previous commit
    await util.promisify(fs.writeFile)(path.join(target.dir, 'ignore.txt'), 'ignore');
    await target.commitFile('.gitignore', 'ignore.txt');

    const error = await catchError(async () => {
      await sync(source, {
        target: target.dir,
        sourceDir: '.',
      });
    });
    expect(error).toEqual(new Error('conflict'));

    await target.run(['checkout', 'master-gitsync-conflict']);

    const status = await target.run(['status', '-s']);
    expect(status).toBe('?? ignore.txt');
  });

  test('sync historical commits will create branch to avoid overwrite', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    // Create a merge that only in the source repository
    await source.run(['checkout', '-b', 'branch']);
    await source.commitFile('test.txt', 'branch content', 'branch content');
    await source.run(['checkout', 'master']);
    await source.commitFile('test.txt', 'master content', 'master content');
    try {
      await source.run(['merge', 'branch']);
    } catch (e) {
      // Ignore merge error
    }
    await source.commitFile('test.txt', 'merged content', 'merged content');
    await source.run(['branch', '-d', 'branch']);

    // TODO create in normal way
    // Hack: change to same content
    await source.addFile('test.txt', 'same content');
    await target.addFile('test.txt', 'same content');
    const now = new Date().getTime() / 1000;
    await source.run(['commit', '-am', 'same content'], {env: {GIT_AUTHOR_DATE: now}});
    await target.run(['commit', '-am', 'same content'], {env: {GIT_AUTHOR_DATE: now}});

    // Sync the last commit
    await source.commitFile('test.txt', 'new content');
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
      maxCount: 1,
    });

    const error = await catchError(async () => {
      await sync(source, {
        target: target.dir,
        sourceDir: '.',
      });
    });

    expect(error).toEqual(new Error('conflict'));
  });

  test('sync empty commit to root directory', async () => {
    const source = await createRepo();
    await source.run(['commit', '-m', 'empty', '--allow-empty']);

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    const log = await target.run(['log', '--format=%s']);
    expect(log).toBe('empty');

    const files = await util.promisify(fs.readdir)(target.dir);
    expect(files).toEqual(['.git']);
  });

  test('sync empty commit to sub directory', async () => {
    const now = new Date().getTime() / 1000;

    const source = await createRepo();
    await source.addFile('package-name/test.txt');
    await source.run(['commit', '-m', 'empty'], {env: {GIT_AUTHOR_DATE: now}});

    const target = await createRepo();
    await target.run(['commit', '-m', 'empty', '--allow-empty'], {env: {GIT_AUTHOR_DATE: now}});

    await sync(source, {
      target: target.dir,
      sourceDir: 'package-name',
      targetDir: 'package-name',
    });

    // Only have one commit
    const log = await target.run(['log', '--format=%s']);
    expect(log).toBe('empty');

    expect(logMessage()).toContain('Commits: new: 0, exists: 1, source: 1, target: 1');
  });

  test('getTargetHash fallback to search without date', async () => {
    const source = await createRepo();
    await source.commitFile('test.txt');

    const target = await createRepo();
    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });

    await source.run(['tag', '1.0.0']);

    // Simulation a new commit with old commit date
    const now = new Date().getTime() / 1000 - 60;
    await target.addFile('test2.txt');
    await target.run(['commit', '-m', 'add test2.txt'], {
      env: {
        GIT_COMMITTER_DATE: now,
        GIT_AUTHOR_DATE: now
      }
    });

    await sync(source, {
      target: target.dir,
      sourceDir: '.',
    });
    const tags = await target.run(['tag']);
    expect(tags).toContain('1.0.0');
  });

  test('cant sync when repo has conflict branches', async () => {
    const source = await createRepo();

    const target = await createRepo();
    await target.commitFile('test.txt');
    await target.run(['checkout', '-b', 'master-gitsync-conflict']);
    await target.run(['checkout', '-b', 'feature/branch-gitsync-conflict']);

    const error = await catchError(async () => {
      await sync(source, {
        target: target.dir,
        sourceDir: '.',
      });
    });

    expect(error).toEqual(new Error(`Repository "${target.dir}" has unmerged conflict branches "feature/branch-gitsync-conflict, master-gitsync-conflict", please merge or remove branches before syncing.`));
  });
});
