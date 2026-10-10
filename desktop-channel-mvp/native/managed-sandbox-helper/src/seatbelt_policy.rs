// Source-adapted from OpenAI Codex `codex-rs/sandboxing/src/seatbelt.rs`
// at revision 83d1fe0e67b1323f71febc2925817732b449f1d9.
//
// The full Codex runtime templates are preserved under third_party. This file
// only binds their minimal filesystem policy to a managed task workspace and
// intentionally excludes Codex protocol, CLI, proxy, session, and UI code.

use std::fs;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
const BASE_POLICY: &str = include_str!("../third_party/codex-seatbelt/seatbelt_base_policy.sbpl");
#[cfg(target_os = "macos")]
const PLATFORM_DEFAULTS: &str = include_str!("../third_party/codex-seatbelt/restricted_read_only_platform_defaults.sbpl");
#[cfg(target_os = "macos")]
const PROTECTED_ROOT_NAMES: [&str; 3] = [".codex", ".agents", ".git"];

#[cfg(target_os = "macos")]
pub struct WorkspacePolicy {
    pub workspace_root: PathBuf,
}

pub fn canonical_workspace(path: &Path) -> Result<PathBuf, &'static str> {
    if !path.is_absolute() || has_nested_symlink(path) {
        return Err("rejected");
    }
    let normalized = normalize_top_level_alias(path)?;
    let metadata = fs::metadata(&normalized).map_err(|_| "rejected")?;
    if !metadata.is_dir() {
        return Err("rejected");
    }
    Ok(normalized)
}

fn has_nested_symlink(path: &Path) -> bool {
    path.ancestors().any(|ancestor| {
        fs::symlink_metadata(ancestor)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
            && ancestor.parent().and_then(Path::parent).is_some()
    })
}

fn normalize_top_level_alias(path: &Path) -> Result<PathBuf, &'static str> {
    let Some(top_level) = path.ancestors().find(|ancestor| {
        ancestor.parent().is_some() && ancestor.parent().and_then(Path::parent).is_none()
    }) else {
        return Err("rejected");
    };
    if !fs::symlink_metadata(top_level).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Ok(path.to_path_buf());
    }
    let canonical_top_level = top_level.canonicalize().map_err(|_| "rejected")?;
    let suffix = path.strip_prefix(top_level).map_err(|_| "rejected")?;
    Ok(canonical_top_level.join(suffix))
}

#[cfg(target_os = "macos")]
fn seatbelt_quoted(value: &Path) -> Result<String, &'static str> {
    value.to_str()
        .filter(|value| !value.contains(['"', '\\', '\n', '\r']))
        .map(|value| format!("\"{value}\""))
        .ok_or("rejected")
}

#[cfg(target_os = "macos")]
pub fn no_egress_workspace_policy(policy: &WorkspacePolicy) -> Result<String, &'static str> {
    let workspace_path = canonical_workspace(&policy.workspace_root)?;
    let workspace = seatbelt_quoted(&workspace_path)?;
    let mut result = format!("{BASE_POLICY}\n{PLATFORM_DEFAULTS}\n");
    result.push_str(&format!(
        "(allow file-read*)\n(allow file-map-executable (subpath {workspace}))\n(allow file-write* (subpath {workspace}))\n"
    ));
    for name in PROTECTED_ROOT_NAMES {
        let protected_path = seatbelt_quoted(&workspace_path.join(name))?;
        result.push_str(&format!(
            "(deny file-write* (literal {protected_path}))\n(deny file-write* (subpath {protected_path}))\n"
        ));
    }
    // The Codex defaults include a system logging socket. This Profile has no
    // direct egress, loopback, DNS, or unix-domain socket network capability.
    result.push_str("(deny network*)\n");
    Ok(result)
}

// Versioned interactive exec: system runtime plus one workspace, with independent
// outbound IP access. No host home, arbitrary Unix sockets, Keychain or env secrets.
#[cfg(target_os = "macos")]
pub fn isolated_exec_policy(policy: &WorkspacePolicy, network_access: bool) -> Result<String, &'static str> {
    let workspace = seatbelt_quoted(&canonical_workspace(&policy.workspace_root)?)?;
    // Keep OS boot/runtime support, excluding broad host configuration/db reads
    // and inherited extension grants. The old v1 template remains byte-for-byte.
    let mut defaults = PLATFORM_DEFAULTS.to_string();
    for clause in [
        "  (subpath \"/Library/Preferences\")\n",
        "  (subpath \"/var/db\")\n",
        "  (subpath \"/private/var/db\")",
        "  (literal \"/private/etc/master.passwd\")\n",
        "(allow file-read* (subpath \"/etc\"))\n",
        "(allow file-read* (subpath \"/private/etc\"))\n",
        "(allow file-read* (subpath \"/Library/Preferences\"))\n",
        "(allow file-read* (extension \"com.apple.app-sandbox.read\"))\n",
        "(allow file-read* file-write* (extension \"com.apple.app-sandbox.read-write\"))\n",
    ] { defaults = defaults.replace(clause, ""); }
    let mut result = format!("{BASE_POLICY}\n{defaults}\n");
    result.push_str("(allow file-read* file-map-executable (subpath \"/System\") (subpath \"/usr/bin\") (subpath \"/usr/sbin\") (subpath \"/usr/lib\") (subpath \"/usr/libexec\") (subpath \"/usr/share\") (subpath \"/bin\") (subpath \"/sbin\") (subpath \"/Library/Apple\"))\n");
    result.push_str("(allow file-read-metadata (literal \"/\") (literal \"/private\") (literal \"/private/var\") (literal \"/private/var/folders\"))\n");
    result.push_str("(allow file-read* (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\") (literal \"/private/etc/localtime\") (literal \"/private/etc/hosts\") (literal \"/private/etc/resolv.conf\") (literal \"/private/etc/services\") (literal \"/private/etc/ssl/openssl.cnf\") (literal \"/private/etc/ssl/cert.pem\") (subpath \"/private/var/db/timezone\"))\n");
    result.push_str(&format!("(allow file-read* file-map-executable (subpath {workspace}))\n(allow file-write* (subpath {workspace}))\n"));
    for name in PROTECTED_ROOT_NAMES {
        let protected = seatbelt_quoted(&policy.workspace_root.join(name))?;
        result.push_str(&format!("(deny file-write* (subpath {protected}))\n"));
    }
    if network_access {
        result.push_str("(allow network-outbound (remote ip))\n(allow network-bind (local ip \"*:*\"))\n(allow system-socket (socket-domain AF_UNIX))\n(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))\n(allow network-outbound (remote unix-socket (path \"/var/run/mDNSResponder\")))\n(allow mach-lookup (global-name \"com.apple.SystemConfiguration.configd\") (global-name \"com.apple.networkd\") (global-name \"com.apple.SystemConfiguration.DNSConfiguration\"))\n(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))\n");
    } else { result.push_str("(deny network*)\n"); }
    Ok(result)
}
