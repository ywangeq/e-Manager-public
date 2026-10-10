// Scenario-adapted from OpenAI Codex (Apache-2.0).
// Revision: 95ec468619386ebb93506ac2091a48e5a558d25c
// Path: codex-rs/utils/pty/src/process_group_tests.rs
// Adaptation: std::process and bounded synchronous reads/polls, no tokio/anyhow.
use std::io::{self, BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use super::{signal_process_group_with_member_fallback, signal_process_id, terminate_process_group};

struct OwnedGroup(Child);
impl Drop for OwnedGroup {
    fn drop(&mut self) {
        let _ = super::kill_process_group(self.0.id());
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn denied_group_signal_terminates_owned_descendants_and_preserves_escalation() -> io::Result<()> {
    for leader_exited in [false, true] {
        let mut wrapper = OwnedGroup(Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; /bin/sleep 30 & resistant=$!; trap - TERM; /bin/sleep 30 & sibling=$!; printf '%s %s\\n' \"$resistant\" \"$sibling\"; wait"])
            .stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0).spawn()?);
        let process_group_id = wrapper.0.id() as libc::pid_t;
        let stdout = wrapper.0.stdout.take().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = send.send(result);
        });
        let line = receive.recv_timeout(Duration::from_secs(5)).expect("missing descendant IDs")?;
        let pids: Vec<libc::pid_t> = line.split_whitespace().map(|value| value.parse().unwrap()).collect();
        assert_eq!(pids.len(), 2);
        let [resistant_pid, sibling_pid] = [pids[0], pids[1]];
        if leader_exited { wrapper.0.kill()?; wrapper.0.wait()?; }
        let mut denied_leader = false;
        for signal in [libc::SIGTERM, libc::SIGKILL] {
            assert!(signal_process_group_with_member_fallback(process_group_id as u32, signal,
                |_, _| Err(io::Error::from_raw_os_error(libc::EPERM)),
                |pid, signal| {
                    if pid == process_group_id {
                        denied_leader = true;
                        Err(io::Error::from_raw_os_error(libc::EPERM))
                    } else { signal_process_id(pid, signal) }
                })?);
            if signal == libc::SIGTERM {
                assert_eq!(denied_leader, !leader_exited);
                assert!(signal_process_id(resistant_pid, 0)?);
            }
        }
        for pid in [resistant_pid, sibling_pid] {
            let deadline = Instant::now() + Duration::from_secs(5);
            while signal_process_id(pid, 0)? {
                assert!(Instant::now() < deadline, "descendant survives group cleanup");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        if !leader_exited {
            let deadline = Instant::now() + Duration::from_secs(5);
            while wrapper.0.try_wait()?.is_none() {
                assert!(Instant::now() < deadline, "wrapper was not reaped");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    Ok(())
}

#[test]
fn denied_group_signal_rejects_unsafe_process_group_ids() {
    for id in [0, u32::MAX] {
        assert_eq!(terminate_process_group(id).expect_err("unsafe process group ID").kind(), io::ErrorKind::InvalidInput);
    }
}
