export interface PiSessionResumeCommandInput {
  executable: string;
  workingDirectory: string;
  sessionDirectory?: string;
  sessionId: string;
}

const quotePowerShell = (value: string): string => "'" + value.replace(/'/g, "''") + "'";

const quotePosix = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

export const buildPiSessionResumeCommand = (
  input: PiSessionResumeCommandInput,
  platform: NodeJS.Platform = process.platform,
): string => {
  const isJavaScriptEntry = /\.[cm]?js$/i.test(input.executable);
  const executable = isJavaScriptEntry ? 'node' : input.executable;
  const args = [
    ...(isJavaScriptEntry ? [input.executable] : []),
    ...(input.sessionDirectory ? ['--session-dir', input.sessionDirectory] : []),
    '--session',
    input.sessionId,
  ];

  if (platform === 'win32') {
    return [
      'Set-Location -LiteralPath ' + quotePowerShell(input.workingDirectory),
      '& ' + [executable, ...args].map(quotePowerShell).join(' '),
    ].join('; ');
  }

  return (
    'cd -- ' +
    quotePosix(input.workingDirectory) +
    ' && ' +
    [executable, ...args].map(quotePosix).join(' ')
  );
};
