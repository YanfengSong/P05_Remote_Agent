/**
 * Windows PowerShell must discover its own modules. A parent PowerShell 7 host
 * can otherwise inject incompatible modules through the inherited search path.
 * Keep the parent environment intact and let powershell.exe rebuild this value.
 */
export function windowsPowerShellEnv(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  }
  return environment;
}
