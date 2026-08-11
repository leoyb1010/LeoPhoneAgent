import spawn from 'cross-spawn';

export type TaskMasterCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export async function runTaskMasterCommand(
  projectPath: string,
  args: string[],
  stdinInput = '',
): Promise<TaskMasterCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', args, { cwd: projectPath, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdinInput) child.stdin?.write(stdinInput);
    child.stdin?.end();
  });
}
