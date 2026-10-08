mod seatbelt_policy;

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const CONTRACT_VERSION: &str = "managed-sandbox-helper.internal.v1";
#[cfg(target_os = "linux")]
const BWRAP: &str = "/usr/bin/bwrap";
#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
const TOOLCHAIN_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_ARGUMENTS: usize = 256;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InternalExecutionRequest {
    contract_version: String,
    command: Vec<String>,
    timeout_ms: u64,
    workspace_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeExecutionResult {
    contract_version: &'static str,
    status: &'static str,
}

struct ValidatedRequest {
    command: Vec<String>,
    timeout: Duration,
    workspace_root: PathBuf,
}

fn main() {
    let result = read_request()
        .and_then(validate_request)
        .and_then(run_request)
        .unwrap_or_else(safe_result);
    let serialized = serde_json::to_string(&result).unwrap_or_else(|_| {
        "{\"contractVersion\":\"managed-sandbox-helper.private.v1\",\"status\":\"rejected\"}".to_string()
    });
    println!("{serialized}");
}

fn safe_result(status: &'static str) -> SafeExecutionResult {
    SafeExecutionResult {
        contract_version: CONTRACT_VERSION,
        status,
    }
}

fn read_request() -> Result<InternalExecutionRequest, &'static str> {
    let mut body = String::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_string(&mut body)
        .map_err(|_| "rejected")?;
    if body.len() as u64 > MAX_REQUEST_BYTES {
        return Err("rejected");
    }
    serde_json::from_str(&body).map_err(|_| "rejected")
}

fn validate_request(request: InternalExecutionRequest) -> Result<ValidatedRequest, &'static str> {
    if request.contract_version != CONTRACT_VERSION
        || request.command.is_empty()
        || request.command.len() > MAX_ARGUMENTS
        || request.command.iter().any(|argument| argument.is_empty() || argument.len() > 16_384)
        || request.timeout_ms == 0
        || request.timeout_ms > 60_000
    {
        return Err("rejected");
    }
    let command_path = Path::new(&request.command[0]);
    if !command_path.is_absolute() || !command_path.is_file() {
        return Err("rejected");
    }
    let workspace_root = seatbelt_policy::canonical_workspace(Path::new(&request.workspace_root))?;
    Ok(ValidatedRequest {
        command: request.command,
        timeout: Duration::from_millis(request.timeout_ms),
        workspace_root,
    })
}

fn run_request(request: ValidatedRequest) -> Result<SafeExecutionResult, &'static str> {
    #[cfg(target_os = "macos")]
    let mut child = spawn_macos_sandboxed(&request)?;
    #[cfg(target_os = "linux")]
    let mut child = spawn_linux_sandboxed(&request)?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err("unavailable");

    let deadline = Instant::now() + request.timeout;
    loop {
        if let Some(exit) = child.try_wait().map_err(|_| "failed")? {
            return Ok(safe_result(if exit.success() { "completed" } else { "failed" }));
        }
        if Instant::now() >= deadline {
            terminate_process_tree(&mut child);
            return Ok(safe_result("timed_out"));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "macos")]
fn spawn_macos_sandboxed(request: &ValidatedRequest) -> Result<Child, &'static str> {
    if !Path::new(SANDBOX_EXEC).is_file() {
        return Err("unavailable");
    }
    let policy = seatbelt_policy::no_egress_workspace_policy(&seatbelt_policy::WorkspacePolicy {
        workspace_root: request.workspace_root.clone(),
    })?;
    let task_tmpdir = request.workspace_root.join(".managed-sandbox-tmp");
    fs::create_dir_all(&task_tmpdir).map_err(|_| "failed")?;
    let cpu_seconds = request.timeout.as_secs().saturating_add(1).max(1);
    let mut command = Command::new(SANDBOX_EXEC);
    command
        .arg("-p")
        .arg(policy)
        .arg("--")
        .args(&request.command)
        .current_dir(&request.workspace_root)
        .env_clear()
        .env("HOME", &request.workspace_root)
        .env("TMPDIR", task_tmpdir)
        .env("PATH", TOOLCHAIN_PATH)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            set_limit(libc::RLIMIT_CPU, cpu_seconds, cpu_seconds)?;
            set_limit(libc::RLIMIT_FSIZE, 64 * 1024 * 1024, 64 * 1024 * 1024)?;
            set_limit(libc::RLIMIT_NOFILE, 128, 128)?;
            set_limit(libc::RLIMIT_CORE, 0, 0)
        });
    }
    command.spawn().map_err(|_| "unavailable")
}

#[cfg(target_os = "linux")]
fn spawn_linux_sandboxed(request: &ValidatedRequest) -> Result<Child, &'static str> {
    if !Path::new(BWRAP).is_file() {
        return Err("unavailable");
    }
    let task_tmpdir = request.workspace_root.join(".managed-sandbox-tmp");
    fs::create_dir_all(&task_tmpdir).map_err(|_| "failed")?;
    let cpu_seconds = request.timeout.as_secs().saturating_add(1).max(1);
    let mut command = Command::new(BWRAP);
    command
        .args([
            "--unshare-user",
            "--uid",
            "0",
            "--gid",
            "0",
            "--unshare-pid",
            "--unshare-net",
            "--unshare-ipc",
            "--unshare-uts",
            "--die-with-parent",
            "--clearenv",
            "--setenv",
            "HOME",
        ])
        .arg("/workspace")
        .args(["--setenv", "TMPDIR"])
        .arg("/workspace/.managed-sandbox-tmp")
        .args(["--setenv", "PATH", TOOLCHAIN_PATH])
        // Start from an empty root.  Toolchain directories are read-only and
        // the task workspace is the only host-backed writable mount.
        .args([
            "--tmpfs",
            "/",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--dir",
            "/usr",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/lib",
            "/lib",
            "--ro-bind",
            "/lib64",
            "/lib64",
            "--symlink",
            "usr/bin",
            "/bin",
            "--dir",
            "/workspace",
            "--bind",
        ])
        .arg(&request.workspace_root)
        .arg("/workspace")
        .arg("--chdir")
        .arg("/workspace")
        .arg("--")
        .args(&request.command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            set_limit(libc::RLIMIT_CPU, cpu_seconds, cpu_seconds)?;
            set_limit(libc::RLIMIT_FSIZE, 64 * 1024 * 1024, 64 * 1024 * 1024)?;
            set_limit(libc::RLIMIT_NOFILE, 128, 128)?;
            set_limit(libc::RLIMIT_CORE, 0, 0)
        });
    }
    command.spawn().map_err(|_| "unavailable")
}

#[cfg(target_os = "macos")]
fn set_limit(resource: libc::c_int, current: u64, maximum: u64) -> io::Result<()> {
  let limit = libc::rlimit {
    rlim_cur: current as libc::rlim_t,
    rlim_max: maximum as libc::rlim_t,
    };
    if unsafe { libc::setrlimit(resource, &limit) } == -1 {
        return Err(io::Error::last_os_error());
  }
  Ok(())
}

#[cfg(target_os = "linux")]
fn set_limit(resource: libc::__rlimit_resource_t, current: u64, maximum: u64) -> io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: current as libc::rlim_t,
        rlim_max: maximum as libc::rlim_t,
    };
    if unsafe { libc::setrlimit(resource, &limit) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn terminate_process_tree(child: &mut Child) {
    let pid = child.id() as libc::pid_t;
    unsafe {
        libc::killpg(pid, libc::SIGTERM);
    }
    thread::sleep(Duration::from_millis(100));
    if child.try_wait().ok().flatten().is_none() {
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
