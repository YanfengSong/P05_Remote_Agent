import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createIsolationBackend, IsolationUnavailableError, type IsolationHostFacts, type IsolationRequirements } from "../v3/isolation/backend.js";

const exec = promisify(execFile);
const requirements: IsolationRequirements = { mode: "isolated-worker", filesystem: "workspace-only", network: "none", readOnlyReferences: true, processTreeControl: true };
const optimistic: IsolationHostFacts = { osVersion: "test", edition: "test", hypervisorPresent: true, windowsSandboxExecutable: true,
  appContainerApiLibrary: true, wslExecutable: true, dockerExecutable: true, bubblewrapExecutable: true, appContainerLauncher: true, optionalFeatureQuery: "ENABLED" };
for (const adapter of [
  { platform: "win32" as const, probe: async () => optimistic },
  { platform: "win32" as const, probe: async (): Promise<IsolationHostFacts> => { throw new Error("probe unavailable"); } }
]) {
  const backend = createIsolationBackend(adapter);
  const report = await backend.probe();
  assert.equal(report.availability, "UNAVAILABLE");
  assert.equal(report.actualSecurityMode, null);
  assert.ok(report.backends.every(item => item.availability === "UNAVAILABLE" && item.networkEnforcement === "unverified" && item.filesystemEnforcement === "unverified"));
  await assert.rejects(backend.require(requirements), error => error instanceof IsolationUnavailableError && error.code === "ISOLATION_BACKEND_UNAVAILABLE");
}
const system = createIsolationBackend();
const inventory = await system.probe();
assert.equal(inventory.availability, "UNAVAILABLE");
await assert.rejects(system.require(requirements), IsolationUnavailableError);
console.log("V3_ISOLATION_INVENTORY " + JSON.stringify({ availability: inventory.availability, probeCode: inventory.probeCode, facts: inventory.facts }));

const candidate = process.argv[2] === "--wsl-poc" ? process.argv[3] : undefined;
if (candidate) {
  assert.equal(process.platform, "win32", "WSL experiment requires Windows");
  assert.match(candidate, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  const running = await exec("wsl.exe", ["--list", "--running", "--quiet"], { windowsHide: true, timeout: 10000, maxBuffer: 8192, encoding: "buffer" });
  const names = running.stdout.includes(0) ? running.stdout.toString("utf16le") : running.stdout.toString("utf8");
  assert.ok(names.replace(/^\uFEFF/, "").split(/\r?\n/).map(value => value.trim()).includes(candidate), "Never start a stopped distribution for this experiment");
  const python = String.raw`
import os, sys, json, tempfile, pathlib, subprocess, socket, resource
runner = r'''
import os, json, pathlib, socket, subprocess, sys
checks = []
def denied_write(p):
    try: pathlib.Path(p).write_text('escape')
    except OSError: return True
    return False
def denied_read(p):
    try: pathlib.Path(p).read_text()
    except OSError: return True
    return False
pathlib.Path('/workspace/allowed.txt').write_text('allowed')
assert pathlib.Path('/reference/read.txt').read_text() == 'reference'
assert denied_write('/reference/read.txt')
assert denied_write('/runner/immutable.txt')
assert denied_read('/workspace/outside-link')
assert not any(pathlib.Path(p).exists() for p in ['/mnt/c', '/init', '/run/WSL', '/run/WSLInterop'])
assert not any(k.startswith('P05_') or k.startswith('WSL') for k in os.environ)
checks.extend(['workspace-write', 'reference-readonly', 'runner-readonly', 'outside-link-denied', 'windows-mount-and-interop-hidden', 'environment-cleared'])
status = pathlib.Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\t1' in status
assert next(line.split(':',1)[1].strip() for line in status.splitlines() if line.startswith('CapEff:')) == '0000000000000000'
assert os.readlink('/proc/self/ns/net') != sys.argv[2]
assert all(name == 'lo' for _, name in socket.if_nameindex())
sock = socket.socket(); sock.settimeout(0.5)
try: sock.connect(('127.0.0.1', int(sys.argv[1])))
except OSError: pass
else: raise AssertionError('isolated network reached host positive-control listener')
finally: sock.close()
checks.extend(['no-new-privileges', 'capabilities-dropped', 'separate-network-namespace', 'host-loopback-denied'])
child = subprocess.run(['/usr/bin/python3', '-c', 'import pathlib; assert not pathlib.Path("/mnt/c").exists(); assert not pathlib.Path("/workspace/outside-link").exists()'], check=False, timeout=3)
assert child.returncode == 0
checks.append('descendant-inherits-mount-boundary')
print(json.dumps({'checks':checks}))
'''
def limits():
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024, 512*1024*1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024*1024, 1024*1024))
with tempfile.TemporaryDirectory(prefix='p05-isolation-poc-') as temp:
    root = pathlib.Path(temp)
    for name in ['workspace', 'reference', 'runner']: (root/name).mkdir()
    (root/'secret').write_text('outside')
    (root/'reference'/'read.txt').write_text('reference')
    (root/'runner'/'immutable.txt').write_text('runner')
    (root/'workspace'/'outside-link').symlink_to(root/'secret')
    listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen()
    port = listener.getsockname()[1]
    control = socket.create_connection(('127.0.0.1', port), timeout=1); control.close()
    net = os.readlink('/proc/self/ns/net')
    args = ['/usr/bin/bwrap', '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/run',
      '--bind', str(root/'workspace'), '/workspace', '--ro-bind', str(root/'reference'), '/reference', '--ro-bind', str(root/'runner'), '/runner',
      '--chdir', '/workspace', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1',
      '--', '/usr/bin/python3', '-c', runner, str(port), net]
    result = subprocess.run(args, capture_output=True, text=True, timeout=12, preexec_fn=limits)
    listener.close()
    assert (root/'secret').read_text() == 'outside'
    assert (root/'reference'/'read.txt').read_text() == 'reference'
    assert (root/'runner'/'immutable.txt').read_text() == 'runner'
    if result.returncode != 0:
        print(json.dumps({'experiment':'FAILED', 'exitCode':result.returncode, 'diagnostic':result.stderr[:2048]}))
        sys.exit(1)
    assert (root/'workspace'/'allowed.txt').read_text() == 'allowed'
    print(json.dumps({'experiment':'PASSED', 'scope':'temporary Linux namespaces only; production backend remains UNAVAILABLE', 'evidence':json.loads(result.stdout)}))
`;
  try {
    const evidence = await exec("wsl.exe", ["--distribution", candidate, "--exec", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE=1", "/usr/bin/python3", "-c", python],
      { windowsHide: true, timeout: 25000, maxBuffer: 16384, encoding: "utf8" });
    console.log("V3_ISOLATION_WSL_EXPERIMENT " + evidence.stdout.trim());
  } catch (error) {
    const evidence = error as { stdout?: string; stderr?: string };
    console.error("V3_ISOLATION_WSL_EXPERIMENT " + (evidence.stdout ?? evidence.stderr ?? "UNAVAILABLE").slice(0, 4096));
    throw new Error("ISOLATION_EXPERIMENT_FAILED; production backend remains UNAVAILABLE");
  }
}
console.log("V3_ISOLATION_OK (inventory cannot grant isolation; no fallback dispatch; optional experiment is not production attestation)");
