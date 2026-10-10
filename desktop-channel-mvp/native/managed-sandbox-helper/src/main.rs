mod seatbelt_policy;
mod head_tail_buffer;
mod process_group;
use head_tail_buffer::HeadTailBuffer;

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read};
use std::sync::{Arc, Mutex};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const EXEC_CONTRACT_VERSION: &str = "managed-sandbox-helper.internal.v2";
const MAX_OUTPUT_BYTES: usize = 32 * 1024;
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
    #[serde(default)]
    network_access: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeExecutionResult {
    contract_version: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stderr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_truncated: Option<bool>,
}

struct ValidatedRequest {
    command: Vec<String>,
    timeout: Duration,
    workspace_root: PathBuf,
    private_output: bool,
    network_access: bool,
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
        stdout: None,
        stderr: None,
        exit_code: None,
        output_truncated: None,
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
    let private_output = request.contract_version == EXEC_CONTRACT_VERSION;
    if (!private_output && request.contract_version != CONTRACT_VERSION)
        || (!private_output && request.network_access.is_some())
        || (private_output && request.network_access.is_none())
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
        private_output,
        network_access: request.network_access.unwrap_or(false),
    })
}

fn run_request(request: ValidatedRequest) -> Result<SafeExecutionResult, &'static str> {
    #[cfg(target_os = "macos")]
    let mut child = spawn_macos_sandboxed(&request)?;
    #[cfg(target_os = "linux")]
    let mut child = spawn_linux_sandboxed(&request)?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err("unavailable");

    let stdout = capture_output(child.stdout.take());
    let stderr = capture_output(child.stderr.take());
    let deadline = Instant::now() + request.timeout;
    let (status, exit_code) = loop {
        if let Some(exit) = child.try_wait().map_err(|_| "failed")? {
            // A descendant must not outlive a completed command and keep its pipes open.
            terminate_process_tree(&mut child);
            break (if exit.success() { "completed" } else { "failed" }, exit.code());
        }
        if Instant::now() >= deadline {
            terminate_process_tree(&mut child);
            break ("timed_out", None);
        }
        thread::sleep(Duration::from_millis(10));
    };
    let mut result = safe_result(status);
    if request.private_output {
        result.contract_version = EXEC_CONTRACT_VERSION;
        let (out, out_truncated) = output_snapshot(stdout);
        let (err, err_truncated) = output_snapshot(stderr);
        result.stdout = Some(out);
        result.stderr = Some(err);
        result.exit_code = exit_code;
        result.output_truncated = Some(out_truncated || err_truncated);
    }
    Ok(result)
}

type CapturedOutput = Arc<Mutex<(HeadTailBuffer<MAX_OUTPUT_BYTES>, bool)>>;
fn capture_output<T: Read + Send + 'static>(pipe: Option<T>) -> CapturedOutput {
    let captured = Arc::new(Mutex::new((HeadTailBuffer::default(), pipe.is_none())));
    if let Some(mut pipe) = pipe {
        let shared = Arc::clone(&captured);
        thread::spawn(move || {
            let mut chunk = [0_u8; 4096];
            while let Ok(count) = pipe.read(&mut chunk) {
                if count == 0 { break; }
                let mut output = shared.lock().unwrap();
                output.0.push_chunk(&chunk[..count]);
            }
            shared.lock().unwrap().1 = true;
        });
    }
    captured
}
fn output_snapshot(output: CapturedOutput) -> (String, bool) {
    let deadline = Instant::now() + Duration::from_millis(100);
    while !output.lock().unwrap().1 && Instant::now() < deadline { thread::sleep(Duration::from_millis(1)); }
    let output = output.lock().unwrap();
    (String::from_utf8_lossy(&output.0.to_bytes_with_omission_marker()).into_owned(), output.0.omitted_bytes() > 0 || !output.1)
}

#[cfg(target_os = "macos")]
fn spawn_macos_sandboxed(request: &ValidatedRequest) -> Result<Child, &'static str> {
    if !Path::new(SANDBOX_EXEC).is_file() {
        return Err("unavailable");
    }
    let workspace_policy = seatbelt_policy::WorkspacePolicy { workspace_root: request.workspace_root.clone() };
    let policy = if request.private_output {
        seatbelt_policy::isolated_exec_policy(&workspace_policy, request.network_access)?
    } else { seatbelt_policy::no_egress_workspace_policy(&workspace_policy)? };
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
        .stdout(if request.private_output { Stdio::piped() } else { Stdio::null() })
        .stderr(if request.private_output { Stdio::piped() } else { Stdio::null() });
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
    // Network-enabled Linux needs its own verified networking policy.
    if request.network_access { return Err("unavailable"); }
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
        .stdout(if request.private_output { Stdio::piped() } else { Stdio::null() })
        .stderr(if request.private_output { Stdio::piped() } else { Stdio::null() });
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
    let pid = child.id();
    let _ = process_group::terminate_process_group(pid);
    thread::sleep(Duration::from_millis(100));
    // The root may have exited while descendants still hold stdout/stderr.
    let _ = process_group::kill_process_group(pid);
    let _ = child.kill();
    let _ = child.wait();
}
