// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

function spawnAsync(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stdout = '';
    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.on('error', (error) => { reject(error); });
    child.on('close', (code) => {
      if (code === 0) { resolve({ stdout }); return; }
      reject(new Error(`Command failed with code ${code}`));
    });
  });
}

/**
 * Read git configuration from system's global git config
 * @returns {Promise<{git_name: string|null, git_email: string|null}>}
 */
export async function getSystemGitConfig(): Promise<{ git_name: string | null; git_email: string | null }> {
  try {
    const [nameResult, emailResult] = await Promise.all([
      spawnAsync('git', ['config', '--global', 'user.name']).catch(() => ({ stdout: '' })),
      spawnAsync('git', ['config', '--global', 'user.email']).catch(() => ({ stdout: '' }))
    ]);

    return {
      git_name: nameResult.stdout.trim() || null,
      git_email: emailResult.stdout.trim() || null
    };
  } catch (error) {
    return { git_name: null, git_email: null };
  }
}
