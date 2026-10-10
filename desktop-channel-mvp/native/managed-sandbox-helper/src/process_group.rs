// Source-adapted from OpenAI Codex (Apache-2.0).
// Revision: 95ec468619386ebb93506ac2091a48e5a558d25c
// Path: codex-rs/utils/pty/src/process_group.rs
// Only group-signalling functions; no Codex process/session/TTY runtime.
use std::io;

#[cfg(unix)]
fn signal_process_group_id(pgid: libc::pid_t, signal: libc::c_int) -> io::Result<bool> {
    use std::io::ErrorKind;

    let result = unsafe { libc::killpg(pgid, signal) };
    if result == -1 {
        let err = io::Error::last_os_error();
        if err.kind() == ErrorKind::NotFound || err.raw_os_error() == Some(libc::ESRCH) {
            return Ok(false);
        }
        return Err(err);
    }

    Ok(true)
}

#[cfg(target_os = "macos")]
fn signal_process_id(pid: libc::pid_t, signal: libc::c_int) -> io::Result<bool> {
    if unsafe { libc::kill(pid, signal) } == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(false);
        }
        return Err(error);
    }

    Ok(true)
}

#[cfg(target_os = "macos")]
fn signal_process_group_with_member_fallback(
    process_group_id: u32,
    signal: libc::c_int,
    signal_group: impl FnOnce(libc::pid_t, libc::c_int) -> io::Result<bool>,
    mut signal_member: impl FnMut(libc::pid_t, libc::c_int) -> io::Result<bool>,
) -> io::Result<bool> {
    let process_group_id = libc::pid_t::try_from(process_group_id)
        .ok()
        .filter(|process_group_id| *process_group_id > 0)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid process group ID"))?;

    match signal_group(process_group_id, signal) {
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {}
        result => return result,
    }

    let mut process_ids: Vec<libc::pid_t> = vec![0; 16];
    loop {
        let buffer_size = libc::c_int::try_from(std::mem::size_of_val(process_ids.as_slice()))
            .map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "process group is too large")
            })?;
        let count = unsafe {
            libc::proc_listpgrppids(
                process_group_id,
                process_ids.as_mut_ptr().cast(),
                buffer_size,
            )
        };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        let count = count as usize;
        if count < process_ids.len() {
            process_ids.truncate(count);
            break;
        }
        let capacity = process_ids.len().checked_mul(2).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "process group is too large")
        })?;
        process_ids.resize(capacity, 0);
    }
    process_ids.sort_unstable_by_key(|process_id| *process_id == process_group_id);

    let mut signalled = false;
    let mut first_error = None;
    for process_id in process_ids {
        if process_id <= 0 {
            continue;
        }
        let current_group_id = unsafe { libc::getpgid(process_id) };
        if current_group_id == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) && first_error.is_none() {
                first_error = Some(error);
            }
            continue;
        }
        if current_group_id != process_group_id {
            continue;
        }
        match signal_member(process_id, signal) {
            Ok(delivered) => signalled |= delivered,
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
    }

    if signalled {
        Ok(true)
    } else {
        first_error.map_or(Ok(false), Err)
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
/// Send SIGTERM to a specific process group ID (best-effort).
///
/// Returns `Ok(true)` when SIGTERM was delivered to an existing group and
/// `Ok(false)` when the group no longer exists.
pub fn terminate_process_group(process_group_id: u32) -> io::Result<bool> {
    signal_process_group_id(process_group_id as libc::pid_t, libc::SIGTERM)
}

#[cfg(target_os = "macos")]
/// Send SIGTERM to a specific process group, retrying denied signals against its members.
///
/// Returns `Ok(true)` when the group or at least one member was signalled.
pub fn terminate_process_group(process_group_id: u32) -> io::Result<bool> {
    signal_process_group_with_member_fallback(
        process_group_id,
        libc::SIGTERM,
        signal_process_group_id,
        signal_process_id,
    )
}

#[cfg(all(unix, not(target_os = "macos")))]
/// Kill a specific process group ID (best-effort).
pub fn kill_process_group(process_group_id: u32) -> io::Result<()> {
    signal_process_group_id(process_group_id as libc::pid_t, libc::SIGKILL).map(|_| ())
}

#[cfg(target_os = "macos")]
/// Kill a specific process group, retrying denied signals against its members (best-effort).
pub fn kill_process_group(process_group_id: u32) -> io::Result<()> {
    signal_process_group_with_member_fallback(
        process_group_id,
        libc::SIGKILL,
        signal_process_group_id,
        signal_process_id,
    )
    .map(|_| ())
}

#[cfg(all(test, target_os = "macos"))]
#[path = "process_group_tests.rs"]
mod tests;
