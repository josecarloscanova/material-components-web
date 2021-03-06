/**
 * @license
 * Copyright 2018 Google Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

'use strict';

const mdcProto = require('../proto/mdc.pb').mdc.proto;
const {DiffBase, GitRevision} = mdcProto;

const fs = require('mz/fs');
const {GOLDEN_JSON_RELATIVE_PATH} = require('./constants');

const Cli = require('./cli');
const GitHubApi = require('./github-api');
const GitRepo = require('./git-repo');
const getStackTrace = require('./stacktrace')('DiffBaseParser');

const HTTP_URL_REGEX = new RegExp('^https?://');

class DiffBaseParser {
  constructor() {
    /**
     * @type {!Cli}
     * @private
     */
    this.cli_ = new Cli();

    /**
     * @type {!GitHubApi}
     * @private
     */
    this.gitHubApi_ = new GitHubApi();

    /**
     * @type {!GitRepo}
     * @private
     */
    this.gitRepo_ = new GitRepo();
  }

  /**
   * @return {!Promise<!mdc.proto.DiffBase>}
   */
  async parseGoldenDiffBase() {
    return await this.getTravisDiffBase_() || await this.parseDiffBase(this.cli_.diffBase);
  }

  /**
   * @return {!Promise<!mdc.proto.DiffBase>}
   */
  async parseSnapshotDiffBase() {
    return await this.getTravisDiffBase_() || await this.parseDiffBase('HEAD');
  }

  /**
   * @return {!Promise<!mdc.proto.DiffBase>}
   */
  async parseMasterDiffBase() {
    /** @type {!mdc.proto.DiffBase} */
    const goldenDiffBase = await this.parseGoldenDiffBase();
    const prNumber = goldenDiffBase.git_revision ? goldenDiffBase.git_revision.pr_number : null;
    let baseBranch = 'origin/master';
    if (prNumber) {
      if (process.env.TRAVIS_BRANCH) {
        baseBranch = `origin/${process.env.TRAVIS_BRANCH}`;
      } else {
        baseBranch = await this.gitHubApi_.getPullRequestBaseBranch(prNumber) || baseBranch;
      }
    }
    return this.parseDiffBase(baseBranch);
  }

  /**
   * @param {string} rawDiffBase
   * @return {!Promise<!mdc.proto.DiffBase>}
   */
  async parseDiffBase(rawDiffBase) {
    const isOnline = this.cli_.isOnline();
    const isRealBranch = (branch) => Boolean(branch) && !['master', 'origin/master', 'HEAD'].includes(branch);

    /** @type {!mdc.proto.DiffBase} */
    const parsedDiffBase = await this.parseDiffBase_(rawDiffBase);
    const parsedBranch = parsedDiffBase.git_revision ? parsedDiffBase.git_revision.branch : null;

    if (isOnline && isRealBranch(parsedBranch) && process.env.TRAVIS) {
      const prNumber = await this.gitHubApi_.getPullRequestNumber(parsedBranch);
      if (prNumber) {
        parsedDiffBase.git_revision.pr_number = prNumber;
      }
    }

    return parsedDiffBase;
  }

  /**
   * @param {string} rawDiffBase
   * @return {!Promise<!mdc.proto.DiffBase>}
   * @private
   */
  async parseDiffBase_(rawDiffBase) {
    // Diff against a public `golden.json` URL.
    // E.g.: `--diff-base=https://storage.googleapis.com/.../golden.json`
    const isUrl = HTTP_URL_REGEX.test(rawDiffBase);
    if (isUrl) {
      return await this.createPublicUrlDiffBase_(rawDiffBase);
    }

    // Diff against a local `golden.json` file.
    // E.g.: `--diff-base=/tmp/golden.json`
    const isLocalFile = await fs.exists(rawDiffBase);
    if (isLocalFile) {
      return await this.createLocalFileDiffBase_(rawDiffBase);
    }

    const [inputGoldenRef, inputGoldenPath] = rawDiffBase.split(':');
    const goldenFilePath = inputGoldenPath || GOLDEN_JSON_RELATIVE_PATH;

    const isRemoteBranch = inputGoldenRef.startsWith('origin/');
    const isVersionTag = /^v[0-9.]+$/.test(inputGoldenRef);
    const isFetchable = isRemoteBranch || isVersionTag;
    const skipFetch = this.cli_.skipFetch;
    const isOnline = this.cli_.isOnline();
    if (isFetchable && !skipFetch && isOnline) {
      await this.gitRepo_.fetch();
    }

    const fullGoldenRef = await this.gitRepo_.getFullSymbolicName(inputGoldenRef);

    // Diff against a specific git commit.
    // E.g.: `--diff-base=abcd1234`
    if (!fullGoldenRef) {
      return await this.createCommitDiffBase_(inputGoldenRef, goldenFilePath);
    }

    const {remoteRef, localRef, tagRef} = this.getRefType_(fullGoldenRef);

    // Diff against a remote git branch.
    // E.g.: `--diff-base=origin/master` or `--diff-base=origin/feat/button/my-fancy-feature`
    if (remoteRef) {
      return await this.createRemoteBranchDiffBase_(remoteRef, goldenFilePath);
    }

    // Diff against a remote git tag.
    // E.g.: `--diff-base=v0.34.1`
    if (tagRef) {
      return await this.createRemoteTagDiffBase_(tagRef, goldenFilePath);
    }

    // Diff against a local git branch.
    // E.g.: `--diff-base=master` or `--diff-base=HEAD`
    return await this.createLocalBranchDiffBase_(localRef, goldenFilePath);
  }

  /**
   * @return {!Promise<?mdc.proto.DiffBase>}
   * @private
   */
  async getTravisDiffBase_() {
    /** @type {?mdc.proto.GitRevision} */
    const travisGitRevision = await this.getTravisGitRevision();
    if (!travisGitRevision) {
      return null;
    }

    let generatedInputString;
    if (travisGitRevision.pr_number) {
      generatedInputString = `travis/pr/${travisGitRevision.pr_number}`;
    } else if (travisGitRevision.tag) {
      generatedInputString = `travis/tag/${travisGitRevision.tag}`;
    } else if (travisGitRevision.branch) {
      generatedInputString = `travis/branch/${travisGitRevision.branch}`;
    } else {
      generatedInputString = `travis/commit/${travisGitRevision.commit}`;
    }

    return DiffBase.create({
      type: DiffBase.Type.GIT_REVISION,
      input_string: generatedInputString,
      git_revision: travisGitRevision,
    });
  }

  /**
   * @return {?Promise<!mdc.proto.GitRevision>}
   */
  async getTravisGitRevision() {
    const travisBranch = process.env.TRAVIS_BRANCH;
    const travisTag = process.env.TRAVIS_TAG;
    const travisPrNumber = Number(process.env.TRAVIS_PULL_REQUEST);
    const travisPrBranch = process.env.TRAVIS_PULL_REQUEST_BRANCH;
    const travisPrSha = process.env.TRAVIS_PULL_REQUEST_SHA;
    const travisCommit = process.env.TRAVIS_COMMIT;
    const commit = travisPrSha || travisCommit;

    if (!commit) {
      return null;
    }

    const logInfo = {travisBranch, travisTag, travisPrNumber, travisPrBranch, travisPrSha, travisCommit};
    const author = await this.gitRepo_.getCommitAuthor(commit, getStackTrace('getTravisGitRevision', logInfo));
    const date = await this.gitRepo_.getCommitDate(commit, getStackTrace('getTravisGitRevision', logInfo));

    if (travisPrNumber) {
      return GitRevision.create({
        type: GitRevision.Type.TRAVIS_PR,
        golden_json_file_path: GOLDEN_JSON_RELATIVE_PATH,
        commit,
        author,
        date,
        branch: travisPrBranch || travisBranch,
        pr_number: travisPrNumber,
      });
    }

    if (travisTag) {
      return GitRevision.create({
        type: GitRevision.Type.REMOTE_TAG,
        golden_json_file_path: GOLDEN_JSON_RELATIVE_PATH,
        commit,
        author,
        date,
        tag: travisTag,
      });
    }

    if (travisBranch) {
      return GitRevision.create({
        type: GitRevision.Type.LOCAL_BRANCH,
        golden_json_file_path: GOLDEN_JSON_RELATIVE_PATH,
        commit,
        author,
        date,
        branch: travisBranch,
      });
    }

    return null;
  }

  /**
   * @param {string} publicUrl
   * @return {!mdc.proto.DiffBase}
   * @private
   */
  createPublicUrlDiffBase_(publicUrl) {
    return DiffBase.create({
      type: DiffBase.Type.PUBLIC_URL,
      input_string: publicUrl,
      public_url: publicUrl,
    });
  }

  /**
   * @param {string} localFilePath
   * @return {!mdc.proto.DiffBase}
   * @private
   */
  createLocalFileDiffBase_(localFilePath) {
    return DiffBase.create({
      type: DiffBase.Type.FILE_PATH,
      input_string: localFilePath,
      local_file_path: localFilePath,
      is_default_local_file: localFilePath === GOLDEN_JSON_RELATIVE_PATH,
    });
  }

  /**
   * @param {string} commit
   * @param {string} goldenJsonFilePath
   * @return {!mdc.proto.DiffBase}
   * @private
   */
  async createCommitDiffBase_(commit, goldenJsonFilePath) {
    const author = await this.gitRepo_.getCommitAuthor(commit, getStackTrace('createCommitDiffBase_'));
    const date = await this.gitRepo_.getCommitDate(commit, getStackTrace('createCommitDiffBase_'));

    return DiffBase.create({
      type: DiffBase.Type.GIT_REVISION,
      input_string: `${commit}:${goldenJsonFilePath}`, // TODO(acdvorak): Document the ':' separator format
      git_revision: GitRevision.create({
        type: GitRevision.Type.COMMIT,
        golden_json_file_path: goldenJsonFilePath,
        commit,
        author,
        date,
      }),
    });
  }

  /**
   * @param {string} remoteRef
   * @param {string} goldenJsonFilePath
   * @return {!mdc.proto.DiffBase}
   * @private
   */
  async createRemoteBranchDiffBase_(remoteRef, goldenJsonFilePath) {
    const allRemoteNames = await this.gitRepo_.getRemoteNames();
    const remote = allRemoteNames.find((curRemoteName) => remoteRef.startsWith(curRemoteName + '/'));
    const branch = remoteRef.substr(remote.length + 1); // add 1 for forward-slash separator
    const commit = await this.gitRepo_.getFullCommitHash(remoteRef);
    const author = await this.gitRepo_.getCommitAuthor(commit, getStackTrace('createRemoteBranchDiffBase_'));
    const date = await this.gitRepo_.getCommitDate(commit, getStackTrace('createRemoteBranchDiffBase_'));

    return DiffBase.create({
      type: DiffBase.Type.GIT_REVISION,
      input_string: `${remoteRef}:${goldenJsonFilePath}`, // TODO(acdvorak): Document the ':' separator format
      git_revision: GitRevision.create({
        type: GitRevision.Type.REMOTE_BRANCH,
        golden_json_file_path: goldenJsonFilePath,
        commit,
        author,
        date,
        remote,
        branch,
      }),
    });
  }

  /**
   * @param {string} tagRef
   * @param {string} goldenJsonFilePath
   * @return {!mdc.proto.DiffBase}
   * @private
   */
  async createRemoteTagDiffBase_(tagRef, goldenJsonFilePath) {
    const commit = await this.gitRepo_.getFullCommitHash(tagRef);
    const author = await this.gitRepo_.getCommitAuthor(commit, getStackTrace('createRemoteTagDiffBase_'));
    const date = await this.gitRepo_.getCommitDate(commit, getStackTrace('createRemoteTagDiffBase_'));

    return DiffBase.create({
      type: DiffBase.Type.GIT_REVISION,
      input_string: `${tagRef}:${goldenJsonFilePath}`, // TODO(acdvorak): Document the ':' separator format
      git_revision: GitRevision.create({
        type: GitRevision.Type.REMOTE_TAG,
        golden_json_file_path: goldenJsonFilePath,
        commit,
        author,
        date,
        remote: 'origin',
        tag: tagRef,
      }),
    });
  }

  /**
   * @param {string} branch
   * @param {string} goldenJsonFilePath
   * @return {!mdc.proto.DiffBase}
   * @private
   */
  async createLocalBranchDiffBase_(branch, goldenJsonFilePath) {
    const commit = await this.gitRepo_.getFullCommitHash(branch);
    const author = await this.gitRepo_.getCommitAuthor(commit, getStackTrace('createLocalBranchDiffBase_'));
    const date = await this.gitRepo_.getCommitDate(commit, getStackTrace('createLocalBranchDiffBase_'));

    return DiffBase.create({
      type: DiffBase.Type.GIT_REVISION,
      input_string: `${branch}:${goldenJsonFilePath}`, // TODO(acdvorak): Document the ':' separator format
      git_revision: GitRevision.create({
        type: GitRevision.Type.LOCAL_BRANCH,
        golden_json_file_path: goldenJsonFilePath,
        commit,
        author,
        date,
        branch,
      }),
    });
  }

  /**
   * @param {string} fullRef
   * @return {{remoteRef: string, localRef: string, tagRef: string}}
   * @private
   */
  getRefType_(fullRef) {
    const getShortGoldenRef = (type) => {
      const regex = new RegExp(`^refs/${type}s/(.+)$`);
      const match = regex.exec(fullRef) || [];
      return match[1];
    };

    const remoteRef = getShortGoldenRef('remote');
    const localRef = getShortGoldenRef('head');
    const tagRef = getShortGoldenRef('tag');

    return {remoteRef, localRef, tagRef};
  }
}

module.exports = DiffBaseParser;
