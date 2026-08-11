import path from 'path';
import os from 'os';
// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import { promises as fs } from 'fs';
import crypto from 'crypto';

import spawn from 'cross-spawn';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { Octokit } from '@octokit/rest';

import { logger } from '@/modules/logging/index.js';
import { userDb, apiKeysDb, githubTokensDb, projectsDb } from '@/modules/database/index.js';
import {
  providerModelsService,
  queryClaudeSDK,
  queryCodex,
  spawnCursor,
  spawnOpenCode,
  spawnGrok,
} from '@/modules/providers/index.js';
import { normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';

import {
  autogenerateBranchName,
  cleanupProject,
  cloneGitHubRepo,
  createGitHubPR,
  getCommitMessages,
  getGitRemoteUrl,
  parseGitHubUrl,
  ResponseCollector,
  SSEStreamWriter,
  validateBranchName,
} from './agent.service.js';

const router = express.Router();
const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

type BranchInfo = { name: string; url: string } | { error: string };
type PullRequestInfo = { number: number; url: string } | { error: string };
type AgentResponsePayload = {
  success: boolean;
  sessionId: string | null;
  messages: unknown[];
  tokens: ReturnType<ResponseCollector['getTotalTokens']>;
  projectPath: string;
  branch?: BranchInfo;
  pullRequest?: PullRequestInfo;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}


/**
 * Middleware to authenticate agent API requests.
 *
 * Supports two authentication modes:
 * 1. Platform mode (IS_PLATFORM=true): For managed/hosted deployments where
 *    authentication is handled by an external proxy. Requests are trusted and
 *    the default user context is used.
 *
 * 2. API key mode (default): For self-hosted deployments where users authenticate
 *    via API keys created in the UI. Keys are validated against the local database.
 */
const validateExternalApiKey = (req: Request, res: Response, next: NextFunction) => {
  // Platform mode: Authentication is handled externally (e.g., by a proxy layer).
  // Trust the request and use the default user context.
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Header only: keys in a query string end up in access logs, proxy logs,
  // and browser history (S-2 companion fix).
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  const user = apiKeysDb.validateApiKey(String(apiKey));

  if (!user) {
    return res.status(401).json({ error: 'Invalid or inactive API key' });
  }

  req.user = user;
  next();
};

/**
 * Get the remote URL of a git repository
 * @param {string} repoPath - Path to the git repository
 * @returns {Promise<string>} - Remote URL of the repository
 */
// ===============================
// External API Endpoint
// ===============================

/**
 * POST /api/agent
 *
 * Trigger an AI agent to work on a project.
 * Supports automatic GitHub branch and pull request creation after successful completion.
 *
 * ================================================================================================
 * REQUEST BODY PARAMETERS
 * ================================================================================================
 *
 * @param {string} githubUrl - (Conditionally Required) GitHub repository URL to clone.
 *                             Supported formats:
 *                             - HTTPS: https://github.com/owner/repo
 *                             - HTTPS with .git: https://github.com/owner/repo.git
 *                             - SSH: git@github.com:owner/repo
 *                             - SSH with .git: git@github.com:owner/repo.git
 *
 * @param {string} projectPath - (Conditionally Required) Path to existing project OR destination for cloning.
 *                               Behavior depends on usage:
 *                               - If used alone: Must point to existing project directory
 *                               - If used with githubUrl: Target location for cloning
 *                               - If omitted with githubUrl: Auto-generates temporary path in ~/.claude/external-projects/
 *
 * @param {string} message - (Required) Task description for the AI agent. Used as:
 *                          - Instructions for the agent
 *                          - Source for auto-generated branch names (if createBranch=true and no branchName)
 *                          - Fallback for PR title if no commits are made
 *
 * @param {string} provider - (Optional) AI provider to use. Options: 'claude' | 'cursor' | 'codex' | 'opencode'
 *                           Default: 'claude'
 *
 * @param {boolean} stream - (Optional) Enable Server-Sent Events (SSE) streaming for real-time updates.
 *                          Default: true
 *                          - true: Returns text/event-stream with incremental updates
 *                          - false: Returns complete JSON response after completion
 *
 * @param {string} model - (Optional) Model identifier for providers.
 *
 *                        Claude models: 'default', 'sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]', 'fable'
 *                        Cursor models: 'gpt-5' (default), 'gpt-5.2', 'gpt-5.2-high', 'sonnet-4.5', 'opus-4.5',
 *                                       'composer-1', 'auto', 'gpt-5.1', 'gpt-5.1-high',
 *                                       'gpt-5.1-codex', 'gpt-5.1-codex-high', 'gpt-5.1-codex-max',
 *                                       'gpt-5.1-codex-max-high', 'opus-4.1', 'grok', and thinking variants
 *                        Codex models: 'gpt-5.4' (default), 'gpt-5.5', 'gpt-5.4-mini'
 *
 * @param {string} effort - (Optional) Reasoning effort for providers/models that support it.
 *                          Claude supports: 'low', 'medium', 'high', 'xhigh', 'max' depending on model.
 *                          Codex supports: 'low', 'medium', 'high', 'xhigh'.
 *                          'default' or omission lets the provider decide.
 *
 * @param {boolean} cleanup - (Optional) Auto-cleanup project directory after completion.
 *                           Default: true
 *                           Behavior:
 *                           - Only applies when cloning via githubUrl (not for existing projectPath)
 *                           - Deletes cloned repository after 5 seconds
 *                           - Also deletes associated Claude session directory
 *                           - Remote branch and PR remain on GitHub if created
 *
 * @param {string} githubToken - (Optional) GitHub Personal Access Token for authentication.
 *                              Overrides stored token from user settings.
 *                              Required for:
 *                              - Private repositories
 *                              - Branch/PR creation features
 *                              Token must have 'repo' scope for full functionality.
 *
 * @param {string} branchName - (Optional) Custom name for the Git branch.
 *                             If provided, createBranch is automatically set to true.
 *                             Validation rules (errors returned if violated):
 *                             - Cannot be empty or whitespace only
 *                             - Cannot start or end with dot (.)
 *                             - Cannot contain consecutive dots (..)
 *                             - Cannot contain spaces
 *                             - Cannot contain special characters: ~ ^ : ? * [ \
 *                             - Cannot contain @{
 *                             - Cannot start or end with forward slash (/)
 *                             - Cannot contain consecutive slashes (//)
 *                             - Cannot end with .lock
 *                             - Cannot contain ASCII control characters
 *                             Examples: 'feature/user-auth', 'bugfix/login-error', 'refactor/db-optimization'
 *
 * @param {boolean} createBranch - (Optional) Create a new Git branch after successful agent completion.
 *                                Default: false (or true if branchName is provided)
 *                                Behavior:
 *                                - Creates branch locally and pushes to remote
 *                                - If branch exists locally: Checks out existing branch (no error)
 *                                - If branch exists on remote: Uses existing branch (no error)
 *                                - Branch name: Custom (if branchName provided) or auto-generated from message
 *                                - Requires either githubUrl OR projectPath with GitHub remote
 *
 * @param {boolean} createPR - (Optional) Create a GitHub Pull Request after successful completion.
 *                            Default: false
 *                            Behavior:
 *                            - PR title: First commit message (or fallback to message parameter)
 *                            - PR description: Auto-generated from all commit messages
 *                            - Base branch: Always 'main' (currently hardcoded)
 *                            - If PR already exists: GitHub returns error with details
 *                            - Requires either githubUrl OR projectPath with GitHub remote
 *
 * ================================================================================================
 * PATH HANDLING BEHAVIOR
 * ================================================================================================
 *
 * Scenario 1: Only githubUrl provided
 *   Input:  { githubUrl: "https://github.com/owner/repo" }
 *   Action: Clones to auto-generated temporary path: ~/.claude/external-projects/<hash>/
 *   Cleanup: Yes (if cleanup=true)
 *
 * Scenario 2: Only projectPath provided
 *   Input:  { projectPath: "/home/user/my-project" }
 *   Action: Uses existing project at specified path
 *   Validation: Path must exist and be accessible
 *   Cleanup: No (never cleanup existing projects)
 *
 * Scenario 3: Both githubUrl and projectPath provided
 *   Input:  { githubUrl: "https://github.com/owner/repo", projectPath: "/custom/path" }
 *   Action: Clones githubUrl to projectPath location
 *   Validation:
 *     - If projectPath exists with git repo:
 *       - Compares remote URL with githubUrl
 *       - If URLs match: Reuses existing repo
 *       - If URLs differ: Returns error
 *   Cleanup: Yes (if cleanup=true)
 *
 * ================================================================================================
 * GITHUB BRANCH/PR CREATION REQUIREMENTS
 * ================================================================================================
 *
 * For createBranch or createPR to work, one of the following must be true:
 *
 * Option A: githubUrl provided
 *   - Repository URL directly specified
 *   - Works with both cloning and existing paths
 *
 * Option B: projectPath with GitHub remote
 *   - Project must be a Git repository
 *   - Must have 'origin' remote configured
 *   - Remote URL must point to github.com
 *   - System auto-detects GitHub URL via: git remote get-url origin
 *
 * Additional Requirements:
 *   - Valid GitHub token (from settings or githubToken parameter)
 *   - Token must have 'repo' scope for private repos
 *   - Project must have commits (for PR creation)
 *
 * ================================================================================================
 * VALIDATION & ERROR HANDLING
 * ================================================================================================
 *
 * Input Validations (400 Bad Request):
 *   - Either githubUrl OR projectPath must be provided (not neither)
 *   - message must be non-empty string
 *   - provider must be 'claude', 'cursor', 'codex', or 'opencode'
 *   - createBranch/createPR requires githubUrl OR projectPath (not neither)
 *   - branchName must pass Git naming rules (if provided)
 *
 * Runtime Validations (500 Internal Server Error or specific error in response):
 *   - projectPath must exist (if used alone)
 *   - GitHub URL format must be valid
 *   - Git remote URL must include github.com (for projectPath + branch/PR)
 *   - GitHub token must be available (for private repos and branch/PR)
 *   - Directory conflicts handled (existing path with different repo)
 *
 * Branch Name Validation Errors (returned in response, not HTTP error):
 *   Invalid names return: { branch: { error: "Invalid branch name: <reason>" } }
 *   Examples:
 *   - "my branch" → "Branch name cannot contain spaces"
 *   - ".feature" → "Branch name cannot start with a dot"
 *   - "feature.lock" → "Branch name cannot end with .lock"
 *
 * ================================================================================================
 * RESPONSE FORMATS
 * ================================================================================================
 *
 * Streaming Response (stream=true):
 *   Content-Type: text/event-stream
 *   Events:
 *     - { type: "status", message: "...", projectPath: "..." }
 *     - { type: "claude-response", data: {...} }
 *     - { type: "github-branch", branch: { name: "...", url: "..." } }
 *     - { type: "github-pr", pullRequest: { number: 42, url: "..." } }
 *     - { type: "github-error", error: "..." }
 *     - { type: "done" }
 *
 * Non-Streaming Response (stream=false):
 *   Content-Type: application/json
 *   {
 *     success: true,
 *     sessionId: "session-123",
 *     messages: [...],        // Assistant messages only (filtered)
 *     tokens: {
 *       inputTokens: 150,
 *       outputTokens: 50,
 *       cacheReadTokens: 0,
 *       cacheCreationTokens: 0,
 *       totalTokens: 200
 *     },
 *     projectPath: "/path/to/project",
 *     branch: {               // Only if createBranch=true
 *       name: "feature/xyz",
 *       url: "https://github.com/owner/repo/tree/feature/xyz"
 *     } | { error: "..." },
 *     pullRequest: {          // Only if createPR=true
 *       number: 42,
 *       url: "https://github.com/owner/repo/pull/42"
 *     } | { error: "..." }
 *   }
 *
 * Error Response:
 *   HTTP Status: 400, 401, 500
 *   Content-Type: application/json
 *   { success: false, error: "Error description" }
 *
 * ================================================================================================
 * EXAMPLES
 * ================================================================================================
 *
 * Example 1: Clone and process with auto-cleanup
 *   POST /api/agent
 *   { "githubUrl": "https://github.com/user/repo", "message": "Fix bug" }
 *
 * Example 2: Use existing project with custom branch and PR
 *   POST /api/agent
 *   {
 *     "projectPath": "/home/user/project",
 *     "message": "Add feature",
 *     "branchName": "feature/new-feature",
 *     "createPR": true
 *   }
 *
 * Example 3: Clone to specific path with auto-generated branch
 *   POST /api/agent
 *   {
 *     "githubUrl": "https://github.com/user/repo",
 *     "projectPath": "/tmp/work",
 *     "message": "Refactor code",
 *     "createBranch": true,
 *     "cleanup": false
 *   }
 */
router.post('/', validateExternalApiKey, async (req, res) => {
  const { githubUrl, projectPath, message, provider = 'claude', model, githubToken, branchName, sessionId } = req.body;
  const effort = typeof req.body.effort === 'string' && req.body.effort.trim()
    ? req.body.effort.trim()
    : undefined;

  // Parse stream and cleanup as booleans (handle string "true"/"false" from curl)
  const stream = req.body.stream === undefined ? true : (req.body.stream === true || req.body.stream === 'true');
  const cleanup = req.body.cleanup === undefined ? true : (req.body.cleanup === true || req.body.cleanup === 'true');

  // If branchName is provided, automatically enable createBranch
  const createBranch = branchName ? true : (req.body.createBranch === true || req.body.createBranch === 'true');
  const createPR = req.body.createPR === true || req.body.createPR === 'true';

  // Permission mode for the headless run. A caller may explicitly request any
  // allowed mode (including bypassPermissions when they knowingly need it), but
  // when none is specified we fall back to acceptEdits rather than a full
  // permission bypass: acceptEdits keeps file edits flowing without an
  // interactive prompt (which would hang a headless run) while still refusing
  // unbounded, unreviewed actions by default. ALLOWED_PERMISSION_MODES is
  // unchanged so explicit bypassPermissions requests still work.
  const ALLOWED_PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
  const requestedPermissionMode = typeof req.body.permissionMode === 'string' ? req.body.permissionMode.trim() : '';
  const permissionMode = ALLOWED_PERMISSION_MODES.has(requestedPermissionMode)
    ? requestedPermissionMode
    : 'acceptEdits';
  const skipPermissions = permissionMode === 'bypassPermissions';

  // Validate inputs
  if (!githubUrl && !projectPath) {
    return res.status(400).json({ error: 'Either githubUrl or projectPath is required' });
  }

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  if (!['claude', 'cursor', 'codex', 'opencode', 'grok'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude", "cursor", "codex", "opencode", or "grok"' });
  }

  // Validate GitHub branch/PR creation requirements
  // Allow branch/PR creation with projectPath as long as it has a GitHub remote
  if ((createBranch || createPR) && !githubUrl && !projectPath) {
    return res.status(400).json({ error: 'createBranch and createPR require either githubUrl or projectPath with a GitHub remote' });
  }

  let finalProjectPath: string | null = null;
  let writer: SSEStreamWriter | ResponseCollector | null = null;

  try {
    // Determine the final project path
    if (githubUrl) {
      // Clone repository (to projectPath if provided, otherwise generate path)
      const tokenToUse = githubToken || githubTokensDb.getActiveGithubToken(req.user.id);

      let targetPath;
      if (projectPath) {
        targetPath = projectPath;
      } else {
        // Generate a unique path for cloning
        const repoHash = crypto.createHash('md5').update(githubUrl + Date.now()).digest('hex');
        targetPath = path.join(os.homedir(), '.claude', 'external-projects', repoHash);
      }

      finalProjectPath = await cloneGitHubRepo(githubUrl.trim(), tokenToUse, targetPath);
    } else {
      // Use existing project path
      finalProjectPath = normalizeProjectPath(path.resolve(projectPath));

      // Verify the path exists
      try {
        await fs.access(finalProjectPath);
      } catch (error) {
        throw new Error(`Project path does not exist: ${finalProjectPath}`);
      }
    }

    finalProjectPath = normalizeProjectPath(finalProjectPath);

    // Enforce the same workspace containment check the UI applies when creating a
    // project. Without this, a caller could register (and then operate on) an
    // arbitrary path outside WORKSPACES_ROOT via projectPath, bypassing the
    // guard used by the createProject route.
    const workspaceValidation = await validateWorkspacePath(finalProjectPath);
    if (!workspaceValidation.valid) {
      return res.status(400).json({
        error: workspaceValidation.error || 'Invalid project path',
      });
    }

    // Register project path in DB (or reuse existing active registration)
    const registrationResult = projectsDb.createProjectPath(finalProjectPath, null);
    if (registrationResult.outcome === 'active_conflict') {
      logger.info('Project registration already exists for:', finalProjectPath);
    } else {
      logger.info('Project registered:', registrationResult.project);
    }

    // Set up writer based on streaming mode
    if (stream) {
      // Set up SSE headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      writer = new SSEStreamWriter(res, req.user.id);

      // Send initial status
      writer.send({
        type: 'status',
        message: githubUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
    } else {
      // Non-streaming mode: collect messages
      writer = new ResponseCollector(req.user.id);

      // Collect initial status message
      writer.send({
        type: 'status',
        message: githubUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
    }

    const codexModels = (await providerModelsService.getProviderModels('codex')).models;
    const opencodeModels = (await providerModelsService.getProviderModels('opencode')).models;

    // Start the appropriate session
    if (provider === 'claude') {
      logger.info('🤖 Starting Claude SDK session');

      await queryClaudeSDK(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath!,
        sessionId: sessionId || null,
        model: model,
        effort,
        permissionMode // Defaults to bypassPermissions for headless; caller-overridable
      }, writer);

    } else if (provider === 'cursor') {
      logger.info('🖱️ Starting Cursor CLI session');

      await spawnCursor(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath!,
        sessionId: sessionId || null,
        model: model || undefined,
        skipPermissions // Bypass permissions for Cursor unless caller chose a safer mode
      }, writer);
    } else if (provider === 'codex') {
      logger.info('🤖 Starting Codex SDK session');

      await queryCodex(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath!,
        sessionId: sessionId || null,
        model: model || codexModels.DEFAULT,
        effort,
        permissionMode
      }, writer);
    } else if (provider === 'opencode') {
      logger.info('Starting OpenCode CLI session');

      await spawnOpenCode(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath!,
        sessionId: sessionId || null,
        model: model || opencodeModels.DEFAULT,
        effort,
        permissionMode // Defaults to bypassPermissions for headless; caller-overridable
      }, writer);
    } else if (provider === 'grok') {
      logger.info('Starting Grok Build CLI session');

      await spawnGrok(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath!,
        sessionId: sessionId || null,
        model: model || undefined,
        effort,
        permissionMode // Defaults to bypassPermissions for headless; caller-overridable
      }, writer);
    }

    // Handle GitHub branch and PR creation after successful agent completion
    let branchInfo = null;
    let prInfo = null;

    if (createBranch || createPR) {
      try {
        logger.info('🔄 Starting GitHub branch/PR creation workflow...');

        // Get GitHub token
        const tokenToUse = githubToken || githubTokensDb.getActiveGithubToken(req.user.id);

        if (!tokenToUse) {
          throw new Error('GitHub token required for branch/PR creation. Please configure a GitHub token in settings.');
        }

        // Initialize Octokit
        const octokit = new Octokit({ auth: tokenToUse });

        // Get GitHub URL - either from parameter or from git remote
        let repoUrl = githubUrl;
        if (!repoUrl) {
          logger.info('🔍 Getting GitHub URL from git remote...');
          try {
            repoUrl = await getGitRemoteUrl(finalProjectPath);
            if (!repoUrl.includes('github.com')) {
              throw new Error('Project does not have a GitHub remote configured');
            }
            logger.info(`✅ Found GitHub remote: ${repoUrl}`);
          } catch (error) {
            throw new Error(`Failed to get GitHub remote URL: ${errorMessage(error)}`);
          }
        }

        // Parse GitHub URL to get owner and repo
        const { owner, repo } = parseGitHubUrl(repoUrl);
        logger.info(`📦 Repository: ${owner}/${repo}`);

        // Use provided branch name or auto-generate from message
        const finalBranchName = branchName || autogenerateBranchName(message);
        if (branchName) {
          logger.info(`🌿 Using provided branch name: ${finalBranchName}`);

          // Validate custom branch name
          const validation = validateBranchName(finalBranchName);
          if (!validation.valid) {
            throw new Error(`Invalid branch name: ${validation.error}`);
          }
        } else {
          logger.info(`🌿 Auto-generated branch name: ${finalBranchName}`);
        }

        if (createBranch) {
          // Create and checkout the new branch locally
          logger.info('🔄 Creating local branch...');
          const checkoutProcess = spawn('git', ['checkout', '-b', finalBranchName], {
            cwd: finalProjectPath!,
            stdio: 'pipe'
          });

          await new Promise<void>((resolve, reject) => {
            let stderr = '';
            checkoutProcess.stderr?.on('data', (data) => { stderr += data.toString(); });
            checkoutProcess.on('close', (code) => {
              if (code === 0) {
                logger.info(`✅ Created and checked out local branch '${finalBranchName}'`);
                resolve();
              } else {
                // Branch might already exist locally, try to checkout
                if (stderr.includes('already exists')) {
                  logger.info(`ℹ️ Branch '${finalBranchName}' already exists locally, checking out...`);
                  const checkoutExisting = spawn('git', ['checkout', finalBranchName], {
                    cwd: finalProjectPath!,
                    stdio: 'pipe'
                  });
                  checkoutExisting.on('close', (checkoutCode) => {
                    if (checkoutCode === 0) {
                      logger.info(`✅ Checked out existing branch '${finalBranchName}'`);
                      resolve();
                    } else {
                      reject(new Error(`Failed to checkout existing branch: ${stderr}`));
                    }
                  });
                } else {
                  reject(new Error(`Failed to create branch: ${stderr}`));
                }
              }
            });
          });

          // Push the branch to remote
          logger.info('🔄 Pushing branch to remote...');
          const pushProcess = spawn('git', ['push', '-u', 'origin', finalBranchName], {
            cwd: finalProjectPath!,
            stdio: 'pipe'
          });

          await new Promise<void>((resolve, reject) => {
            let stderr = '';
            let stdout = '';
            pushProcess.stdout?.on('data', (data) => { stdout += data.toString(); });
            pushProcess.stderr?.on('data', (data) => { stderr += data.toString(); });
            pushProcess.on('close', (code) => {
              if (code === 0) {
                logger.info(`✅ Pushed branch '${finalBranchName}' to remote`);
                resolve();
              } else {
                // Check if branch exists on remote but has different commits
                if (stderr.includes('already exists') || stderr.includes('up-to-date')) {
                  logger.info(`ℹ️ Branch '${finalBranchName}' already exists on remote, using existing branch`);
                  resolve();
                } else {
                  reject(new Error(`Failed to push branch: ${stderr}`));
                }
              }
            });
          });

          branchInfo = {
            name: finalBranchName,
            url: `https://github.com/${owner}/${repo}/tree/${finalBranchName}`
          };
        }

        if (createPR) {
          // Get commit messages to generate PR description
          logger.info('🔄 Generating PR title and description...');
          const commitMessages = await getCommitMessages(finalProjectPath, 5);

          // Use the first commit message as the PR title, or fallback to the agent message
          const prTitle = commitMessages.length > 0 ? commitMessages[0] : message;

          // Generate PR body from commit messages
          let prBody = '## Changes\n\n';
          if (commitMessages.length > 0) {
            prBody += commitMessages.map(msg => `- ${msg}`).join('\n');
          } else {
            prBody += `Agent task: ${message}`;
          }
          prBody += '\n\n---\n*This pull request was automatically created by leocodebox Agent.*';

          logger.info(`📝 PR Title: ${prTitle}`);

          // Create the pull request
          logger.info('🔄 Creating pull request...');
          prInfo = await createGitHubPR(octokit, owner, repo, finalBranchName, prTitle, prBody, 'main');
        }

        // Send branch/PR info in response
        if (stream) {
          if (branchInfo) {
            writer.send({
              type: 'github-branch',
              branch: branchInfo
            });
          }
          if (prInfo) {
            writer.send({
              type: 'github-pr',
              pullRequest: prInfo
            });
          }
        }

      } catch (error) {
        console.error('❌ GitHub branch/PR creation error:', error);

        // Send error but don't fail the entire request
        if (stream) {
          writer.send({
            type: 'github-error',
            error: errorMessage(error)
          });
        }
        // Store error info for non-streaming response
        if (!stream) {
          branchInfo = { error: errorMessage(error) };
          prInfo = { error: errorMessage(error) };
        }
      }
    }

    // Handle response based on streaming mode
    if (stream) {
      // Streaming mode: end the SSE stream
      writer.end();
    } else {
      // Non-streaming mode: send filtered messages and token summary as JSON
      if (!(writer instanceof ResponseCollector)) throw new Error('Non-streaming response collector was not initialized.');
      const assistantMessages = writer.getAssistantMessages();
      const tokenSummary = writer.getTotalTokens();

      const response: AgentResponsePayload = {
        success: true,
        sessionId: writer.getSessionId(),
        messages: assistantMessages,
        tokens: tokenSummary,
        projectPath: finalProjectPath
      };

      // Add branch/PR info if created
      if (branchInfo) {
        response.branch = branchInfo;
      }
      if (prInfo) {
        response.pullRequest = prInfo;
      }

      res.json(response);
    }

    // Clean up if requested
    if (cleanup && githubUrl) {
      // Only cleanup if we cloned a repo (not for existing project paths)
      const sessionIdForCleanup = writer.getSessionId();
      setTimeout(() => {
        cleanupProject(finalProjectPath!, sessionIdForCleanup);
      }, 5000);
    }

  } catch (error) {
    console.error('❌ External session error:', error);

    // Clean up on error
    if (finalProjectPath && cleanup && githubUrl) {
      const sessionIdForCleanup = writer ? writer.getSessionId() : null;
      cleanupProject(finalProjectPath!, sessionIdForCleanup);
    }

    if (stream) {
      // For streaming, send error event and stop
      if (!writer) {
        // Set up SSE headers if not already done
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        writer = new SSEStreamWriter(res, req.user.id);
      }

      if (!res.writableEnded) {
        writer.send({
          type: 'error',
          error: errorMessage(error),
          message: `Failed: ${errorMessage(error)}`
        });
        writer.end();
      }
    } else if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: errorMessage(error)
      });
    }
  }
});

export default router;
