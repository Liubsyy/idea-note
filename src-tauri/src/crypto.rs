// Per-block note encryption.
//
// Two layers of keys, and the split is the whole point:
//
//   password ──Argon2id(salt)──> KEK ──unwrap──> MK ──> each ```secret block
//
// The MK is random and normally stable for a workspace; the password only ever
// wraps it. Changing the password rewraps the same MK, so it never rewrites a
// single note. The explicit reset operation is the exception: it rotates the
// MK and deliberately migrates every encrypted note under a crash-safe
// dual-key transition.
//
// Slots work like LUKS key slots: several wrapped copies of the same MK, each
// openable by a different secret (the password, the recovery code, later a
// second password). Unlocking just tries them in turn — the Poly1305 tag *is*
// the "was that the right secret" test, so no password hash is ever stored.
//
// The MK never crosses the IPC boundary. Commands take plaintext and return
// ciphertext (or the reverse); nothing here returns key material, and nothing
// should ever be changed to.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use zeroize::{Zeroize, Zeroizing};

/* ------------------------------ error codes ----------------------------- */

// Returned as bare strings so the frontend can switch on them. Anything not in
// this list is an IO/parse detail meant for a toast, never for control flow.
pub const ERR_LOCKED: &str = "locked";
pub const ERR_UNKNOWN_KEY: &str = "unknown_key";
pub const ERR_TAMPERED: &str = "tampered";
pub const ERR_BAD_FORMAT: &str = "bad_format";
pub const ERR_WRONG_SECRET: &str = "wrong_secret";
pub const ERR_NOT_INITIALIZED: &str = "not_initialized";
pub const ERR_ALREADY_INITIALIZED: &str = "already_initialized";
pub const ERR_ROTATION_PENDING: &str = "rotation_pending";

/* -------------------------------- constants ----------------------------- */

const FORMAT_VERSION: u32 = 1;
const VAULT_VERSION: u32 = 1;
const VAULT_DIR: &str = ".ideanote";
const VAULT_FILE: &str = "vault.json";

const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;
const TAG_LEN: usize = 16;

/// Argon2id cost. 64 MiB × 3 passes puts a single guess in the ~0.3–1s range on
/// a desktop CPU, which is what makes an exposed vault.json expensive to attack
/// offline. Stored per slot so these can be raised later without stranding
/// vaults written by an older build.
const ARGON_M_COST: u32 = 65536; // KiB
const ARGON_T_COST: u32 = 3;
const ARGON_P_COST: u32 = 1;

/// How long the master key may sit in memory after the user enters a valid
/// password or recovery code. This is an absolute session lifetime: using the
/// key does not extend it.
///
/// Encoding, shared with the frontend setting:
///   -1 = drop the key the moment the operation that needed it finishes
///    0 = never expire
///   >0 = minutes from successful unlock
const DEFAULT_TTL_MINUTES: i64 = 15;

/* ------------------------------ on-disk shape --------------------------- */

#[derive(Serialize, Deserialize, Clone)]
struct KdfParams {
    alg: String,
    m: u32,
    t: u32,
    p: u32,
    /// Not a secret, and required on every device: without it the same password
    /// derives a different KEK and the vault can't be opened anywhere else.
    salt: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Slot {
    id: String,
    /// "password" | "recovery" — decides how the typed secret is normalized.
    #[serde(rename = "type")]
    kind: String,
    label: String,
    key_id: String,
    kdf: KdfParams,
    /// base64(nonce ‖ wrapped MK ‖ tag)
    wrapped: String,
    created_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    version: u32,
    active_key_id: String,
    slots: Vec<Slot>,
    /// Present only while a crash-safe master-key rotation is committing note
    /// files. Old and target slots coexist until every note has moved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rotation: Option<RotationState>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RotationState {
    target_key_id: String,
    retired_key_ids: Vec<String>,
    started_at: u64,
}

/* ------------------------------ session state --------------------------- */

struct WorkspaceSession {
    keys: HashMap<String, Zeroizing<[u8; KEY_LEN]>>,
    active_key_id: String,
    /// When this workspace was unlocked. `None` is only used while clearing a
    /// session; locked workspaces have no entry in `VaultState::sessions`.
    unlocked_at: Option<Instant>,
}

impl WorkspaceSession {
    fn clear_keys(&mut self) {
        for (_, mut key) in self.keys.drain() {
            key.zeroize();
        }
        self.active_key_id.clear();
        self.unlocked_at = None;
    }
}

pub struct VaultState {
    /// One independent in-memory key session per workspace. All application
    /// windows share this state, so the workspace path is part of the lookup —
    /// no command is allowed to use whichever MK happened to run last.
    sessions: HashMap<PathBuf, WorkspaceSession>,
    /// -1 = immediate, 0 = never, >0 = minutes from successful unlock.
    ttl_minutes: i64,
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            ttl_minutes: DEFAULT_TTL_MINUTES,
        }
    }
}

impl VaultState {
    /// True when the key must not outlive the operation that needed it.
    fn expires_immediately(&self) -> bool {
        self.ttl_minutes < 0
    }

    fn ttl(&self) -> Option<Duration> {
        (self.ttl_minutes > 0).then(|| Duration::from_secs(self.ttl_minutes as u64 * 60))
    }

    /// Drop the keys if they have gone unused for longer than the TTL. The Rust
    /// watchdog calls this at the deadline; commands call it too as a
    /// defense-in-depth check before touching key material.
    fn enforce_ttl(&mut self) {
        // Immediate expiry is not enforced here. This runs *before* the key is
        // used, so a zero-length lifetime would drop it between unlocking
        // and the very first decrypt — the key would never be usable at all.
        // `finish_use` is what drops it, once the work is actually done.
        let Some(ttl) = self.ttl() else {
            return;
        };
        self.sessions.retain(|_, session| {
            let expired = session
                .unlocked_at
                .is_some_and(|unlocked_at| unlocked_at.elapsed() >= ttl);
            if expired {
                session.clear_keys();
                false
            } else {
                true
            }
        });
    }

    fn begin_session(
        &mut self,
        workspace: PathBuf,
        active_key_id: String,
        keys: HashMap<String, Zeroizing<[u8; KEY_LEN]>>,
    ) {
        if let Some(mut old) = self.sessions.remove(&workspace) {
            old.clear_keys();
        }
        self.sessions.insert(
            workspace,
            WorkspaceSession {
                keys,
                active_key_id,
                unlocked_at: Some(Instant::now()),
            },
        );
    }

    /// Called after a command has finished with the key. Only immediate expiry
    /// changes state here; a normal session keeps its original unlock deadline.
    ///
    /// Commands that need the key more than once (a save re-encrypting several
    /// blocks) must do all of it before calling this, which is why encryption
    /// is batched into one command rather than one call per block.
    fn finish_use(&mut self, workspace: &Path) {
        if self.expires_immediately() {
            self.clear_workspace(workspace);
        }
    }

    fn clear_workspace(&mut self, workspace: &Path) {
        if let Some(mut session) = self.sessions.remove(workspace) {
            session.clear_keys();
        }
    }

    /// Seconds until one workspace's keys expire, for that window's countdown.
    fn expires_in_secs(&self, workspace: &Path) -> Option<u64> {
        let ttl = self.ttl()?;
        let unlocked_at = self.sessions.get(workspace)?.unlocked_at?;
        Some(ttl.saturating_sub(unlocked_at.elapsed()).as_secs())
    }

    fn is_unlocked_for(&self, workspace: &Path) -> bool {
        self.sessions
            .get(workspace)
            .is_some_and(|session| !session.keys.is_empty())
    }

    /// Earliest remaining session lifetime. The single watchdog sleeps until
    /// this deadline, expires every due workspace, then recalculates.
    fn next_expiry_in(&self) -> Option<Duration> {
        let ttl = self.ttl()?;
        self.sessions
            .values()
            .filter_map(|session| {
                session
                    .unlocked_at
                    .map(|at| ttl.saturating_sub(at.elapsed()))
            })
            .min()
    }
}

/// Process-wide vault plus a single Rust-side expiry worker. The condition
/// variable lets the worker sleep until the current deadline without polling;
/// every operation that changes that deadline wakes it to recalculate.
pub struct VaultInner {
    state: Mutex<VaultState>,
    expiry_changed: Condvar,
}

impl Default for VaultInner {
    fn default() -> Self {
        Self {
            state: Mutex::new(VaultState::default()),
            expiry_changed: Condvar::new(),
        }
    }
}

impl VaultInner {
    fn lock(&self) -> std::sync::LockResult<MutexGuard<'_, VaultState>> {
        self.state.lock()
    }

    fn notify_expiry_changed(&self) {
        self.expiry_changed.notify_one();
    }

    /// Start exactly one backend worker for the app lifetime. It owns no key
    /// copy: it only locks VaultState at the deadline and clears the canonical
    /// Zeroizing buffers there.
    pub fn start_expiry_watchdog(self: &Arc<Self>) {
        let vault = Arc::clone(self);
        std::thread::Builder::new()
            .name("vault-expiry".into())
            .spawn(move || vault.expiry_watchdog())
            .expect("failed to start vault expiry watchdog");
    }

    fn expiry_watchdog(&self) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };

        loop {
            // A command normally already did this after taking the same lock,
            // but the timeout path reaches it without any frontend activity.
            state.enforce_ttl();

            state = match state.next_expiry_in() {
                Some(remaining) => {
                    match self.expiry_changed.wait_timeout(state, remaining) {
                        Ok((state, _)) => state,
                        Err(poisoned) => poisoned.into_inner().0,
                    }
                }
                None => match self.expiry_changed.wait(state) {
                    Ok(state) => state,
                    Err(poisoned) => poisoned.into_inner(),
                },
            };
        }
    }
}

pub type Vault = Arc<VaultInner>;

/* --------------------------------- helpers ------------------------------ */

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn vault_path(workspace: &str) -> PathBuf {
    Path::new(workspace).join(VAULT_DIR).join(VAULT_FILE)
}

fn read_vault(workspace: &str) -> Result<Option<VaultFile>, String> {
    let path = vault_path(workspace);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return Ok(None),
    };
    // A corrupt vault must never be silently replaced: every encrypted block in
    // the workspace depends on it, so surface the parse error and let the user
    // restore the file from git history.
    serde_json::from_str::<VaultFile>(&raw)
        .map(Some)
        .map_err(|e| format!("vault.json 解析失败（请从 git 历史恢复）：{e}"))
}

/// Replace one file through a sibling temporary file. Keeping the temporary on
/// the same filesystem makes the final rename atomic, so a power loss cannot
/// leave half a ciphertext or half a vault.json behind.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("路径没有父目录：{}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let old_permissions = fs::metadata(path).ok().map(|m| m.permissions());
    let mut temp = tempfile::Builder::new()
        .prefix(".ideanote-rotate-")
        .tempfile_in(parent)
        .map_err(|e| format!("创建临时文件失败（{}）：{e}", path.display()))?;
    temp.write_all(bytes)
        .and_then(|_| temp.flush())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| format!("写入临时文件失败（{}）：{e}", path.display()))?;
    if let Some(permissions) = old_permissions {
        temp.as_file()
            .set_permissions(permissions)
            .map_err(|e| format!("保留文件权限失败（{}）：{e}", path.display()))?;
    }
    temp.persist(path)
        .map_err(|e| format!("替换文件失败（{}）：{}", path.display(), e.error))?;
    Ok(())
}

fn write_vault(workspace: &str, vault: &VaultFile) -> Result<(), String> {
    let path = vault_path(workspace);
    let json = serde_json::to_string_pretty(vault).map_err(|e| e.to_string())?;
    atomic_write(&path, json.as_bytes())
}

fn random_bytes(out: &mut [u8]) {
    rand::rngs::OsRng.fill_bytes(out);
}

fn random_ident(prefix: char) -> String {
    let mut raw = [0u8; 8];
    random_bytes(&mut raw);
    let mut out = String::with_capacity(17);
    out.push(prefix);
    for byte in raw {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// RFC 4648 base32, no padding. 15 random bytes land on exactly 24 characters.
fn base32(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &byte in data {
        buffer = (buffer << 8) | byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// A recovery code is shown grouped for transcription but must hash as one
/// canonical string, or retyping it with different spacing would fail.
fn normalize_recovery(secret: &str) -> String {
    secret
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// Generate the canonical and human-readable forms of a recovery code. The
/// canonical form is what Argon2id receives; the grouped form is shown once.
fn new_recovery_code() -> (Zeroizing<String>, String) {
    let mut raw = [0u8; 15];
    random_bytes(&mut raw);
    let flat = Zeroizing::new(base32(&raw));
    raw.zeroize();
    let grouped = flat
        .as_bytes()
        .chunks(6)
        .map(|chunk| String::from_utf8_lossy(chunk).to_string())
        .collect::<Vec<_>>()
        .join("-");
    (flat, grouped)
}

fn derive_kek(secret: &str, kdf: &KdfParams) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    if kdf.alg != "argon2id" {
        return Err(format!("不支持的 KDF：{}", kdf.alg));
    }
    let salt = STANDARD
        .decode(&kdf.salt)
        .map_err(|_| ERR_BAD_FORMAT.to_string())?;
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(KEY_LEN))
        .map_err(|e| format!("Argon2 参数非法：{e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut kek = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(secret.as_bytes(), &salt, kek.as_mut())
        .map_err(|e| format!("密钥派生失败：{e}"))?;
    Ok(kek)
}

fn seal(key: &[u8; KEY_LEN], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce_bytes = [0u8; NONCE_LEN];
    random_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .map_err(|_| "加密失败".to_string())?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn open(key: &[u8; KEY_LEN], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < NONCE_LEN + TAG_LEN {
        return Err(ERR_BAD_FORMAT.to_string());
    }
    let (nonce_bytes, ciphertext) = sealed.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(
            XNonce::from_slice(nonce_bytes),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| ERR_TAMPERED.to_string())
}

/// The canonical AAD for a block. Built from parsed values, never from the raw
/// fence line: `{v=1,key=k1}` and `{ v = 1 , key = k1 }` mean the same thing, so
/// authenticating the literal text would let one stray space lock a block
/// forever. Only these three fields are covered — a display-only attribute
/// added later (a hint, a label) is NOT authenticated, and must not be treated
/// as if it were.
fn block_aad(v: u32, key_id: &str, block_id: &str) -> String {
    format!("v={v}|key={key_id}|id={block_id}")
}

fn valid_ident(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn make_slot(
    id: &str,
    kind: &str,
    label: &str,
    key_id: &str,
    secret: &str,
    mk: &[u8; KEY_LEN],
) -> Result<Slot, String> {
    make_slot_with(id, kind, label, key_id, secret, mk, ARGON_M_COST, ARGON_T_COST)
}

/// Cost is a parameter only so tests can run in milliseconds; every real slot
/// goes through `make_slot` and gets the full parameters.
#[allow(clippy::too_many_arguments)]
fn make_slot_with(
    id: &str,
    kind: &str,
    label: &str,
    key_id: &str,
    secret: &str,
    mk: &[u8; KEY_LEN],
    m_cost: u32,
    t_cost: u32,
) -> Result<Slot, String> {
    let mut salt = [0u8; 16];
    random_bytes(&mut salt);
    let kdf = KdfParams {
        alg: "argon2id".into(),
        m: m_cost,
        t: t_cost,
        p: ARGON_P_COST,
        salt: STANDARD.encode(salt),
    };
    // A recovery slot is created from the same canonical form unlock will
    // rebuild from the typed code, or the grouping dashes would change the KEK.
    let normalized = if kind == "recovery" {
        normalize_recovery(secret)
    } else {
        secret.to_string()
    };
    let kek = derive_kek(&normalized, &kdf)?;
    let aad = format!("{id}|{}|{}|{}|{}", kdf.alg, kdf.m, kdf.t, kdf.p);
    let wrapped = seal(&kek, mk.as_ref(), aad.as_bytes())?;
    Ok(Slot {
        id: id.into(),
        kind: kind.into(),
        label: label.into(),
        key_id: key_id.into(),
        kdf,
        wrapped: STANDARD.encode(wrapped),
        created_at: now_ms(),
    })
}

/// Try one slot. `Ok(None)` means "this wasn't the right secret", which is not
/// an error — unlock walks every slot before deciding anything.
fn try_slot(slot: &Slot, secret: &str) -> Result<Option<Zeroizing<[u8; KEY_LEN]>>, String> {
    let typed = if slot.kind == "recovery" {
        normalize_recovery(secret)
    } else {
        secret.to_string()
    };
    let kek = derive_kek(&typed, &slot.kdf)?;
    let wrapped = STANDARD
        .decode(&slot.wrapped)
        .map_err(|_| ERR_BAD_FORMAT.to_string())?;
    let aad = format!(
        "{}|{}|{}|{}|{}",
        slot.id, slot.kdf.alg, slot.kdf.m, slot.kdf.t, slot.kdf.p
    );
    match open(&kek, &wrapped, aad.as_bytes()) {
        Ok(mut mk) => {
            if mk.len() != KEY_LEN {
                mk.zeroize();
                return Err(ERR_BAD_FORMAT.to_string());
            }
            let mut key = Zeroizing::new([0u8; KEY_LEN]);
            key.copy_from_slice(&mk);
            mk.zeroize();
            Ok(Some(key))
        }
        Err(_) => Ok(None),
    }
}

/// Open one particular workspace key with any slot that belongs to it. The UI
/// promises that either a password or a recovery code can authorize key-slot
/// maintenance, so callers must not verify only the password slot.
fn open_key_from_slots(
    slots: &[Slot],
    secret: &str,
    key_id: &str,
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    let mut opened = None;
    for slot in slots.iter().filter(|slot| slot.key_id == key_id) {
        if let Some(mk) = try_slot(slot, secret)? {
            // Keep trying all applicable slots so password and recovery-code
            // authorization do not have observably different early exits.
            if opened.is_none() {
                opened = Some(mk);
            }
        }
    }
    opened.ok_or_else(|| ERR_WRONG_SECRET.to_string())
}

/// A rotation deliberately requires the current *password*, not a recovery
/// code. The same password must unwrap every key that is about to be retired,
/// otherwise finishing the migration could strand an older block.
fn open_password_keys(
    slots: &[Slot],
    password: &str,
) -> Result<HashMap<String, Zeroizing<[u8; KEY_LEN]>>, String> {
    let mut keys = HashMap::new();
    for slot in slots.iter().filter(|slot| slot.kind == "password") {
        if let Some(mk) = try_slot(slot, password)? {
            keys.entry(slot.key_id.clone()).or_insert(mk);
        }
    }
    if keys.is_empty() {
        return Err(ERR_WRONG_SECRET.to_string());
    }
    Ok(keys)
}

/* ----------------------- whole-workspace key rotation ------------------ */

#[derive(Clone, Copy, PartialEq)]
enum SecretShape {
    Block,
    Inline,
}

struct SecretSpan {
    shape: SecretShape,
    v: u32,
    key_id: String,
    block_id: String,
    key_from: usize,
    key_to: usize,
    body_from: usize,
    body_to: usize,
}

struct ParsedSecretInfo {
    v: u32,
    key_id: String,
    block_id: String,
    key_from: usize,
    key_to: usize,
}

struct TextLine<'a> {
    start: usize,
    content_end: usize,
    text: &'a str,
}

fn text_lines(text: &str) -> Vec<TextLine<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    for part in text.split_inclusive('\n') {
        let end = start + part.len();
        let mut content_end = end;
        if part.ends_with('\n') {
            content_end = content_end.saturating_sub(1);
            if content_end > start && text.as_bytes()[content_end - 1] == b'\r' {
                content_end -= 1;
            }
        }
        out.push(TextLine {
            start,
            content_end,
            text: &text[start..content_end],
        });
        start = end;
    }
    if text.is_empty() || start < text.len() {
        out.push(TextLine {
            start,
            content_end: text.len(),
            text: &text[start..],
        });
    } else if text.ends_with('\n') {
        out.push(TextLine {
            start,
            content_end: start,
            text: "",
        });
    }
    out
}

fn ascii_prefix(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

fn secret_info_candidate(info: &str) -> bool {
    let trimmed = info.trim_start();
    if !ascii_prefix(trimmed, "secret") {
        return false;
    }
    match trimmed["secret".len()..].chars().next() {
        None => true,
        Some(c) => c == '{' || c.is_whitespace(),
    }
}

/// Inline code named simply `secret` is common in documentation and is not an
/// encrypted span. Unlike a fence language tag, an inline secret declaration
/// is only recognizable once its required attribute object begins.
fn inline_secret_info_candidate(info: &str) -> bool {
    let trimmed = info.trim_start();
    if !ascii_prefix(trimmed, "secret") {
        return false;
    }
    let rest = trimmed["secret".len()..].trim_start();
    if !rest.starts_with('{') {
        return false;
    }
    if let Some(close) = rest.find('}') {
        let attributes = rest[1..close].trim();
        // Documentation often uses `secret {...}` or `secret {…}` as a
        // schematic placeholder. Neither can be emitted by the application,
        // so they are examples rather than damaged encrypted content.
        if matches!(attributes, "..." | "…") {
            return false;
        }
    }
    true
}

fn trim_bounds(value: &str, start: usize, end: usize) -> (usize, usize) {
    let slice = &value[start..end];
    let trimmed_start = slice.trim_start();
    let left = end - trimmed_start.len();
    let trimmed = trimmed_start.trim_end();
    (left, left + trimmed.len())
}

fn parse_secret_info(info: &str) -> Result<ParsedSecretInfo, ()> {
    if !secret_info_candidate(info) {
        return Err(());
    }
    let open = info.find('{').ok_or(())?;
    let close = info.rfind('}').ok_or(())?;
    if close < open || !info[close + 1..].trim().is_empty() {
        return Err(());
    }

    let mut version = None;
    let mut key = None;
    let mut block_id = None;
    let mut entry_start = open + 1;
    for raw in info[open + 1..close].split(',') {
        let raw_end = entry_start + raw.len();
        let (entry_from, entry_to) = trim_bounds(info, entry_start, raw_end);
        entry_start = raw_end + 1;
        if entry_from == entry_to {
            continue;
        }
        let entry = &info[entry_from..entry_to];
        let eq_rel = entry.find('=').ok_or(())?;
        let eq = entry_from + eq_rel;
        let (name_from, name_to) = trim_bounds(info, entry_from, eq);
        let (value_from, value_to) = trim_bounds(info, eq + 1, entry_to);
        let name = info[name_from..name_to].to_ascii_lowercase();
        let value = &info[value_from..value_to];
        match name.as_str() {
            "v" => {
                if version.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(());
                }
                let parsed = value.parse::<u32>().map_err(|_| ())?;
                if parsed == 0 {
                    return Err(());
                }
                version = Some(parsed);
            }
            "key" => {
                if key.is_some() || !valid_ident(value) {
                    return Err(());
                }
                key = Some((value.to_string(), value_from, value_to));
            }
            "id" => {
                if block_id.is_some() || !valid_ident(value) {
                    return Err(());
                }
                block_id = Some(value.to_string());
            }
            _ => {}
        }
    }
    let (key_id, key_from, key_to) = key.ok_or(())?;
    Ok(ParsedSecretInfo {
        v: version.ok_or(())?,
        key_id,
        block_id: block_id.ok_or(())?,
        key_from,
        key_to,
    })
}

/// Opening marker, its length, the info string and that string's byte offset
/// in the line. Mirrors fenceAttrs.ts so examples inside longer fences stay
/// examples during a rotation too.
fn opening_fence(line: &str) -> Option<(u8, usize, &str, usize)> {
    let trimmed = line.trim_start();
    let lead = line.len() - trimmed.len();
    let marker = *trimmed.as_bytes().first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let length = trimmed.bytes().take_while(|b| *b == marker).count();
    if length < 3 {
        return None;
    }
    Some((marker, length, &trimmed[length..], lead + length))
}

fn closes_fence(line: &str, marker: u8, min_length: usize) -> bool {
    let trimmed = line.trim();
    trimmed.len() >= min_length && trimmed.bytes().all(|b| b == marker)
}

fn backtick_run_len(bytes: &[u8], start: usize) -> usize {
    bytes[start..]
        .iter()
        .take_while(|byte| **byte == b'`')
        .count()
}

fn matching_backtick_run(bytes: &[u8], from: usize, length: usize) -> Option<usize> {
    let mut at = from;
    while at < bytes.len() {
        let tick = at + bytes[at..].iter().position(|byte| *byte == b'`')?;
        let run = backtick_run_len(bytes, tick);
        if run == length {
            return Some(tick);
        }
        at = tick + run;
    }
    None
}

fn scan_inline_line(
    line: &TextLine<'_>,
    out: &mut Vec<SecretSpan>,
) -> Result<(), &'static str> {
    let bytes = line.text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        let Some(open_rel) = bytes[at..].iter().position(|b| *b == b'`') else {
            break;
        };
        let open = at + open_rel;
        let delimiter_len = backtick_run_len(bytes, open);
        let Some(close) = matching_backtick_run(bytes, open + delimiter_len, delimiter_len) else {
            if delimiter_len == 1
                && inline_secret_info_candidate(&line.text[open + 1..])
            {
                return Err("行内加密内容未闭合");
            }
            at = open + delimiter_len;
            continue;
        };
        if delimiter_len != 1 {
            // A longer Markdown code span may intentionally contain literal
            // single backticks, including documentation examples such as
            // `` `secret {…} …` ``. Nothing inside it is a live secret.
            at = close + delimiter_len;
            continue;
        }
        let content = &line.text[open + 1..close];
        if !inline_secret_info_candidate(content) {
            at = close + 1;
            continue;
        }
        let brace = content.rfind('}').ok_or("行内加密属性未闭合")?;
        let info = &content[..=brace];
        let parsed = parse_secret_info(info).map_err(|_| "行内加密属性无法识别")?;
        let body_area = &content[brace + 1..];
        let body = body_area.trim_start_matches([' ', '\t']);
        if body.is_empty()
            || body.len() != body.trim_end_matches([' ', '\t']).len()
            || !body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("行内加密密文格式无法识别");
        }
        let content_abs = line.start + open + 1;
        let body_from = content_abs + brace + 1 + (body_area.len() - body.len());
        out.push(SecretSpan {
            shape: SecretShape::Inline,
            v: parsed.v,
            key_id: parsed.key_id,
            block_id: parsed.block_id,
            key_from: content_abs + parsed.key_from,
            key_to: content_abs + parsed.key_to,
            body_from,
            body_to: body_from + body.len(),
        });
        at = close + delimiter_len;
    }
    Ok(())
}

fn scan_secret_spans(text: &str) -> Result<Vec<SecretSpan>, &'static str> {
    let lines = text_lines(text);
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        let Some((marker, marker_len, info, info_offset)) = opening_fence(line.text) else {
            scan_inline_line(line, &mut out)?;
            i += 1;
            continue;
        };
        let mut close = i + 1;
        while close < lines.len() && !closes_fence(lines[close].text, marker, marker_len) {
            close += 1;
        }
        if secret_info_candidate(info) {
            if close >= lines.len() {
                return Err("围栏加密内容未闭合");
            }
            let parsed = parse_secret_info(info).map_err(|_| "围栏加密属性无法识别")?;
            let (body_from, body_to) = if close > i + 1 {
                (lines[i + 1].start, lines[close - 1].content_end)
            } else {
                (line.content_end, line.content_end)
            };
            out.push(SecretSpan {
                shape: SecretShape::Block,
                v: parsed.v,
                key_id: parsed.key_id,
                block_id: parsed.block_id,
                key_from: line.start + info_offset + parsed.key_from,
                key_to: line.start + info_offset + parsed.key_to,
                body_from,
                body_to,
            });
        }
        i = if close < lines.len() { close + 1 } else { lines.len() };
    }
    Ok(out)
}

fn wrap_ciphertext(body: &str, newline: &str) -> String {
    body.as_bytes()
        .chunks(96)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(newline)
}

fn rotation_error(path: &Path, detail: &str) -> String {
    format!("MK 迁移预检失败（{}）：{detail}", path.display())
}

fn rotate_note_text(
    path: &Path,
    text: &str,
    keys: &HashMap<String, Zeroizing<[u8; KEY_LEN]>>,
    target_key_id: &str,
    target_mk: &[u8; KEY_LEN],
) -> Result<(String, usize), String> {
    let spans = scan_secret_spans(text).map_err(|detail| {
        rotation_error(path, &format!("加密内容格式无法识别：{detail}"))
    })?;
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut changed = 0;
    for span in spans {
        if span.v != FORMAT_VERSION {
            return Err(rotation_error(path, "包含当前版本不支持的加密内容"));
        }
        let mk = keys
            .get(&span.key_id)
            .ok_or_else(|| rotation_error(path, &format!("找不到密钥 {}", span.key_id)))?;
        let compact: String = text[span.body_from..span.body_to]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        let sealed = URL_SAFE_NO_PAD
            .decode(compact.as_bytes())
            .map_err(|_| rotation_error(path, "密文编码损坏"))?;
        let aad = block_aad(span.v, &span.key_id, &span.block_id);
        let plaintext = Zeroizing::new(
            open(mk, &sealed, aad.as_bytes())
                .map_err(|_| rotation_error(path, "密文已损坏、被篡改或密钥不匹配"))?,
        );
        if span.key_id == target_key_id {
            continue;
        }
        let target_aad = block_aad(FORMAT_VERSION, target_key_id, &span.block_id);
        let replacement = URL_SAFE_NO_PAD.encode(seal(
            target_mk,
            plaintext.as_slice(),
            target_aad.as_bytes(),
        )?);
        let newline = if span.shape == SecretShape::Block
            && text[..span.body_from].ends_with("\r\n")
        {
            "\r\n"
        } else {
            "\n"
        };
        let body = if span.shape == SecretShape::Block {
            wrap_ciphertext(&replacement, newline)
        } else {
            replacement
        };
        edits.push((span.key_from, span.key_to, target_key_id.to_string()));
        edits.push((span.body_from, span.body_to, body));
        changed += 1;
    }
    if edits.is_empty() {
        return Ok((text.to_string(), 0));
    }
    edits.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = text.to_string();
    for (from, to, replacement) in edits {
        out.replace_range(from..to, &replacement);
    }
    Ok((out, changed))
}

fn is_rotation_excluded(name: &str) -> bool {
    matches!(name, ".git" | ".svn" | ".hg" | ".DS_Store")
}

fn collect_markdown_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("读取目录失败（{}）：{e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_rotation_excluded(&name) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_markdown_files(&entry.path(), out)?;
        } else if metadata.is_file() {
            let lower = name.to_lowercase();
            if lower.ends_with(".md") || lower.ends_with(".markdown") {
                out.push(entry.path());
            }
        }
    }
    Ok(())
}

struct StagedNote {
    path: PathBuf,
    original: Vec<u8>,
    replacement: Vec<u8>,
    secrets_changed: usize,
}

struct RotationBuilt {
    result: RotationResult,
    target_mk: Zeroizing<[u8; KEY_LEN]>,
}

/// A master-key reset is a privileged maintenance operation, not an unlock.
/// Erase the worker's last copy of the new MK and leave the workspace locked,
/// regardless of the configured session TTL. The next secret operation must
/// therefore authenticate against the newly written vault.json.
fn lock_after_master_key_rotation(
    state: &mut VaultState,
    workspace: &Path,
    target_mk: &mut Zeroizing<[u8; KEY_LEN]>,
) {
    target_mk.zeroize();
    state.clear_workspace(workspace);
}

fn rotate_master_key_on_disk(workspace: &str, password: &str) -> Result<RotationBuilt, String> {
    rotate_master_key_on_disk_with_cost(workspace, password, ARGON_M_COST, ARGON_T_COST)
}

fn rotate_master_key_on_disk_with_cost(
    workspace: &str,
    password: &str,
    m_cost: u32,
    t_cost: u32,
) -> Result<RotationBuilt, String> {
    let mut file = read_vault(workspace)?.ok_or_else(|| ERR_NOT_INITIALIZED.to_string())?;
    let mut keys = open_password_keys(&file.slots, password)?;
    let (target_key_id, target_mk, mut transition) =
        if let Some(rotation) = file.rotation.clone() {
            let target_mk = keys
                .get(&rotation.target_key_id)
                .ok_or_else(|| ERR_WRONG_SECRET.to_string())?;
            (
                rotation.target_key_id.clone(),
                Zeroizing::new(**target_mk),
                file.clone(),
            )
        } else {
            if !keys.contains_key(&file.active_key_id) {
                return Err(ERR_WRONG_SECRET.to_string());
            }
            let retired_key_ids: Vec<String> = file
                .slots
                .iter()
                .map(|slot| slot.key_id.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let target_key_id = loop {
                let candidate = random_ident('k');
                if !retired_key_ids.contains(&candidate) {
                    break candidate;
                }
            };
            let mut target_mk = Zeroizing::new([0u8; KEY_LEN]);
            loop {
                random_bytes(target_mk.as_mut());
                if keys.values().all(|old| old.as_ref() != target_mk.as_ref()) {
                    break;
                }
            }
            let password_slot = make_slot_with(
                &random_ident('s'),
                "password",
                "主口令",
                &target_key_id,
                password,
                &target_mk,
                m_cost,
                t_cost,
            )?;
            file.active_key_id = target_key_id.clone();
            file.slots.push(password_slot);
            file.rotation = Some(RotationState {
                target_key_id: target_key_id.clone(),
                retired_key_ids: retired_key_ids.clone(),
                started_at: now_ms(),
            });
            (
                target_key_id,
                target_mk,
                file.clone(),
            )
        };
    keys.insert(target_key_id.clone(), Zeroizing::new(*target_mk));

    let mut paths = Vec::new();
    collect_markdown_files(Path::new(workspace), &mut paths)?;
    paths.sort();
    let mut staged = Vec::new();
    for path in paths {
        let original = fs::read(&path)
            .map_err(|e| format!("读取文件失败（{}）：{e}", path.display()))?;
        let (text, encoding) = crate::encoding::decode(original.clone())
            .map_err(|e| rotation_error(&path, &e))?;
        let (replacement_text, secrets_changed) = rotate_note_text(
            &path,
            &text,
            &keys,
            &target_key_id,
            &target_mk,
        )?;
        if secrets_changed > 0 {
            let (replacement, lossless) = crate::encoding::encode(&replacement_text, encoding);
            if !lossless {
                return Err(rotation_error(&path, "无法保持原文件编码"));
            }
            staged.push(StagedNote {
                path,
                original,
                replacement,
                secrets_changed,
            });
        }
    }

    // The transition is committed before the first note. From here on, any
    // mixture of old and target ciphertext remains decryptable after a crash.
    transition.active_key_id = target_key_id.clone();
    write_vault(workspace, &transition)?;

    for note in &staged {
        let current = fs::read(&note.path)
            .map_err(|e| format!("重新读取文件失败（{}）：{e}", note.path.display()))?;
        if current != note.original {
            return Err(format!(
                "MK 迁移已暂停：文件在迁移期间发生变化（{}）",
                note.path.display()
            ));
        }
        atomic_write(&note.path, &note.replacement)?;
    }

    let password_slot = transition
        .slots
        .iter()
        .find(|slot| slot.kind == "password" && slot.key_id == target_key_id)
        .cloned()
        .ok_or_else(|| ERR_BAD_FORMAT.to_string())?;
    let (recovery_flat, recovery_code) = new_recovery_code();
    let recovery_slot = make_slot_with(
        &random_ident('s'),
        "recovery",
        "恢复码",
        &target_key_id,
        &recovery_flat,
        &target_mk,
        m_cost,
        t_cost,
    )?;
    let final_file = VaultFile {
        version: transition.version,
        active_key_id: target_key_id.clone(),
        slots: vec![password_slot, recovery_slot],
        rotation: None,
    };
    write_vault(workspace, &final_file)?;

    let secrets_changed = staged.iter().map(|note| note.secrets_changed).sum();
    Ok(RotationBuilt {
        result: RotationResult {
            recovery_code,
            files_changed: staged.len(),
            secrets_changed,
            active_key_id: target_key_id,
        },
        target_mk,
    })
}

/* --------------------------------- payloads ----------------------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotInfo {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub key_id: String,
    pub created_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub locked: bool,
    pub active_key_id: String,
    pub slots: Vec<SlotInfo>,
    /// -1 = immediate, 0 = never, >0 = minutes from successful unlock.
    pub ttl_minutes: i64,
    /// Seconds left on that timer, so the UI can schedule its own re-check
    /// instead of polling. None while locked or when expiry is off.
    pub expires_in_secs: Option<u64>,
    pub rotation_pending: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    /// Shown once. There is no second chance to read it out of anywhere.
    pub recovery_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotationResult {
    pub recovery_code: String,
    pub files_changed: usize,
    pub secrets_changed: usize,
    pub active_key_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptResult {
    /// base64url(nonce ‖ ciphertext ‖ tag) — the fence block's body.
    pub body: String,
    pub key_id: String,
    pub v: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptRequest {
    pub block_id: String,
    pub plaintext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedBlock {
    pub block_id: String,
    pub body: String,
    pub key_id: String,
    pub v: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptResult {
    pub plaintext: String,
}

/* --------------------------------- commands ----------------------------- */

#[tauri::command]
pub fn vault_status(workspace: String, vault: State<'_, Vault>) -> Result<VaultStatus, String> {
    let file = read_vault(&workspace)?;
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.enforce_ttl();
    vault.notify_expiry_changed();
    let Some(file) = file else {
        return Ok(VaultStatus {
            initialized: false,
            locked: true,
            active_key_id: String::new(),
            slots: Vec::new(),
            ttl_minutes: state.ttl_minutes,
            expires_in_secs: None,
            rotation_pending: false,
        });
    };
    Ok(VaultStatus {
        initialized: true,
        locked: !state.is_unlocked_for(Path::new(&workspace)),
        ttl_minutes: state.ttl_minutes,
        expires_in_secs: state.expires_in_secs(Path::new(&workspace)),
        rotation_pending: file.rotation.is_some(),
        active_key_id: file.active_key_id.clone(),
        slots: file
            .slots
            .iter()
            .map(|s| SlotInfo {
                id: s.id.clone(),
                kind: s.kind.clone(),
                label: s.label.clone(),
                key_id: s.key_id.clone(),
                created_at: s.created_at,
            })
            .collect(),
    })
}

/// Async on purpose: Argon2id is deliberately slow, and a synchronous Tauri
/// command runs on the main thread — which would freeze the whole window (and
/// any progress animation with it) for the length of the derivation.
#[tauri::command]
pub async fn vault_init(
    workspace: String,
    password: String,
    vault: State<'_, Vault>,
) -> Result<InitResult, String> {
    if read_vault(&workspace)?.is_some() {
        return Err(ERR_ALREADY_INITIALIZED.to_string());
    }
    // No strength rules, deliberately. The threat this feature actually loses
    // to is a forgotten password — that is guaranteed data loss, while a weak
    // one is only a risk — and complexity rules are what make people forget.
    // The recovery code is the safety net; Argon2id's cost is what makes even a
    // short password expensive to attack offline.

    let key_id = "k1";
    let built = tauri::async_runtime::spawn_blocking(
        move || -> Result<(VaultFile, String, Zeroizing<[u8; KEY_LEN]>), String> {
            let mut mk = Zeroizing::new([0u8; KEY_LEN]);
            random_bytes(mk.as_mut());

            let (recovery_flat, recovery_code) = new_recovery_code();

            let file = VaultFile {
                version: VAULT_VERSION,
                active_key_id: key_id.into(),
                slots: vec![
                    make_slot("s1", "password", "主口令", key_id, &password, &mk)?,
                    make_slot("s2", "recovery", "恢复码", key_id, &recovery_flat, &mk)?,
                ],
                rotation: None,
            };
            Ok((file, recovery_code, mk))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    let (file, recovery_code, mk) = built;
    write_vault(&workspace, &file)?;

    // Initializing leaves the vault open — the user is right there, and making
    // them retype the password they just chose is pure friction.
    let mut keys = HashMap::new();
    keys.insert(key_id.into(), mk);
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.begin_session(PathBuf::from(&workspace), key_id.into(), keys);
    vault.notify_expiry_changed();

    Ok(InitResult { recovery_code })
}

#[tauri::command]
pub async fn vault_unlock(
    workspace: String,
    secret: String,
    vault: State<'_, Vault>,
) -> Result<(), String> {
    let file = read_vault(&workspace)?.ok_or_else(|| ERR_NOT_INITIALIZED.to_string())?;
    let active_key_id = file.active_key_id.clone();
    let slots = file.slots;

    // One Argon2id derivation per slot, off the main thread.
    let keys = tauri::async_runtime::spawn_blocking(
        move || -> Result<HashMap<String, Zeroizing<[u8; KEY_LEN]>>, String> {
            let mut keys = HashMap::new();
            for slot in &slots {
                // Every slot is tried, not just the first match: a rotation
                // leaves k1 and k2 side by side and one secret may open both.
                if let Some(mk) = try_slot(slot, &secret)? {
                    keys.entry(slot.key_id.clone()).or_insert(mk);
                }
            }
            Ok(keys)
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    if !keys.contains_key(&active_key_id) {
        // Which slot came closest is deliberately not reported.
        return Err(ERR_WRONG_SECRET.to_string());
    }
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.begin_session(PathBuf::from(&workspace), active_key_id, keys);
    vault.notify_expiry_changed();
    Ok(())
}

/// Change how long the key may linger. Takes effect immediately: shortening it
/// below the current session age clears the key now; otherwise the Rust watchdog
/// is moved to the new deadline.
#[tauri::command]
pub fn vault_set_ttl(minutes: i64, vault: State<'_, Vault>) -> Result<(), String> {
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.ttl_minutes = minutes;
    state.enforce_ttl();
    vault.notify_expiry_changed();
    Ok(())
}

#[tauri::command]
pub fn vault_lock(workspace: String, vault: State<'_, Vault>) -> Result<(), String> {
    vault
        .lock()
        .map_err(|_| "vault state poisoned")?
        .clear_workspace(Path::new(&workspace));
    vault.notify_expiry_changed();
    Ok(())
}

/// Deliberately takes no session state: rewrapping the same MK leaves every
/// already-unlocked key valid, so a password change never locks the user out of
/// the notes they have open.
#[tauri::command]
pub async fn vault_change_password(
    workspace: String,
    old_secret: String,
    new_password: String,
) -> Result<(), String> {
    let mut file = read_vault(&workspace)?.ok_or_else(|| ERR_NOT_INITIALIZED.to_string())?;
    if file.rotation.is_some() {
        return Err(ERR_ROTATION_PENDING.to_string());
    }

    // Rewrap the same MK. No note is touched, so a password change costs one
    // line of diff instead of the whole repository.
    let index = file
        .slots
        .iter()
        .position(|s| s.kind == "password")
        .ok_or_else(|| ERR_NOT_INITIALIZED.to_string())?;
    let old = file.slots[index].clone();
    let slots = file.slots.clone();

    let replacement = tauri::async_runtime::spawn_blocking(move || -> Result<Slot, String> {
        let mk = open_key_from_slots(&slots, &old_secret, &old.key_id)?;
        make_slot(&old.id, "password", &old.label, &old.key_id, &new_password, &mk)
    })
    .await
    .map_err(|e| e.to_string())??;

    file.slots[index] = replacement;
    write_vault(&workspace, &file)
}

/// Replace the recovery slot after proving access with either the current
/// password or recovery code. The old code stops working as soon as vault.json
/// is written with the new wrapped copy of the same MK.
#[tauri::command]
pub async fn vault_regenerate_recovery(
    workspace: String,
    secret: String,
) -> Result<InitResult, String> {
    let mut file = read_vault(&workspace)?.ok_or_else(|| ERR_NOT_INITIALIZED.to_string())?;
    if file.rotation.is_some() {
        return Err(ERR_ROTATION_PENDING.to_string());
    }
    let key_id = file.active_key_id.clone();
    let index = file
        .slots
        .iter()
        .position(|slot| slot.kind == "recovery" && slot.key_id == key_id)
        .ok_or_else(|| ERR_NOT_INITIALIZED.to_string())?;
    let old = file.slots[index].clone();
    let slots = file.slots.clone();

    let (replacement, recovery_code) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(Slot, String), String> {
            let mk = open_key_from_slots(&slots, &secret, &key_id)?;
            let (recovery_flat, recovery_code) = new_recovery_code();
            let replacement = make_slot(
                &old.id,
                "recovery",
                &old.label,
                &old.key_id,
                &recovery_flat,
                &mk,
            )?;
            Ok((replacement, recovery_code))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    file.slots[index] = replacement;
    write_vault(&workspace, &file)?;
    Ok(InitResult { recovery_code })
}

/// Generate a fresh workspace MK and re-encrypt every Markdown secret under
/// it. The blocking worker owns all plaintext and key material; only the new
/// one-time recovery code and migration counts cross IPC.
#[tauri::command]
pub async fn vault_rotate_master_key(
    workspace: String,
    password: String,
    operation: String,
    app: AppHandle,
    vault: State<'_, Vault>,
) -> Result<RotationResult, String> {
    let outcome = async {
        // The coordinating renderer has already made every editor read-only.
        // Clear the old session too so a failed/partial rotation can never keep
        // using an active key id that no longer matches vault.json.
        {
            let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
            state.clear_workspace(Path::new(&workspace));
        }
        vault.notify_expiry_changed();

        let worker_workspace = workspace.clone();
        let built = tauri::async_runtime::spawn_blocking(move || {
            rotate_master_key_on_disk(&worker_workspace, &password)
        })
        .await
        .map_err(|e| e.to_string())??;

        let RotationBuilt {
            result,
            mut target_mk,
        } = built;
        let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
        lock_after_master_key_rotation(&mut state, Path::new(&workspace), &mut target_mk);
        vault.notify_expiry_changed();
        Ok(result)
    }
    .await;

    // The backend owns the fail-safe release. Even if the settings WebView is
    // closed while Argon2 or the file migration is running, every editor gets
    // reloaded and unfrozen when the command ends.
    let _ = app.emit(
        "vault-rotation:end",
        serde_json::json!({
            "operation": operation,
            "workspace": workspace,
            "reload": true,
        }),
    );
    outcome
}

#[tauri::command]
pub fn secret_encrypt(
    workspace: String,
    block_id: String,
    plaintext: String,
    vault: State<'_, Vault>,
) -> Result<EncryptResult, String> {
    if !valid_ident(&block_id) {
        return Err(ERR_BAD_FORMAT.to_string());
    }
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.enforce_ttl();
    let workspace_path = Path::new(&workspace);
    let (key_id, sealed) = {
        let session = state.sessions.get(workspace_path).ok_or(ERR_LOCKED)?;
        let key_id = session.active_key_id.clone();
        let mk = session.keys.get(&key_id).ok_or(ERR_LOCKED)?;
        let aad = block_aad(FORMAT_VERSION, &key_id, &block_id);
        let sealed = seal(mk, plaintext.as_bytes(), aad.as_bytes())?;
        (key_id, sealed)
    };
    state.finish_use(workspace_path);

    Ok(EncryptResult {
        body: URL_SAFE_NO_PAD.encode(sealed),
        key_id,
        v: FORMAT_VERSION,
    })
}

/// Encrypt several blocks in one go.
///
/// A save re-encrypting three edited blocks is one operation as far as the user
/// is concerned, and it has to be one operation as far as the key is concerned
/// too: under immediate expiry the key is dropped the moment a command finishes,
/// so three separate calls would mean three password prompts for one Ctrl+S.
///
/// Either every block is encrypted or none is — a partial result would leave
/// the note half-rewritten with no way to tell which half.
#[tauri::command]
pub fn secret_encrypt_batch(
    workspace: String,
    blocks: Vec<EncryptRequest>,
    vault: State<'_, Vault>,
) -> Result<Vec<EncryptedBlock>, String> {
    for block in &blocks {
        if !valid_ident(&block.block_id) {
            return Err(ERR_BAD_FORMAT.to_string());
        }
    }
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.enforce_ttl();
    let workspace_path = Path::new(&workspace);
    let out = {
        let session = state.sessions.get(workspace_path).ok_or(ERR_LOCKED)?;
        let key_id = session.active_key_id.clone();
        let mk = session.keys.get(&key_id).ok_or(ERR_LOCKED)?;

        let mut out = Vec::with_capacity(blocks.len());
        for block in &blocks {
            let aad = block_aad(FORMAT_VERSION, &key_id, &block.block_id);
            let sealed = seal(mk, block.plaintext.as_bytes(), aad.as_bytes())?;
            out.push(EncryptedBlock {
                block_id: block.block_id.clone(),
                body: URL_SAFE_NO_PAD.encode(sealed),
                key_id: key_id.clone(),
                v: FORMAT_VERSION,
            });
        }
        out
    };
    state.finish_use(workspace_path);
    Ok(out)
}

#[tauri::command]
pub fn secret_decrypt(
    workspace: String,
    v: u32,
    key_id: String,
    block_id: String,
    body: String,
    vault: State<'_, Vault>,
) -> Result<DecryptResult, String> {
    if v != FORMAT_VERSION || !valid_ident(&block_id) || !valid_ident(&key_id) {
        return Err(ERR_BAD_FORMAT.to_string());
    }
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.enforce_ttl();
    let workspace_path = Path::new(&workspace);
    let plaintext = {
        let session = state.sessions.get(workspace_path).ok_or(ERR_LOCKED)?;
        // A block written before a key rotation names the older key; missing it
        // is a different failure from a bad password, and the UI says so.
        let mk = session
            .keys
            .get(&key_id)
            .ok_or_else(|| ERR_UNKNOWN_KEY.to_string())?;

        // Whitespace inside the fence body is layout (the editor wraps long
        // ciphertext), so it is stripped before decoding rather than treated
        // as corruption.
        let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        let sealed = URL_SAFE_NO_PAD
            .decode(compact.as_bytes())
            .map_err(|_| ERR_BAD_FORMAT.to_string())?;

        let aad = block_aad(v, &key_id, &block_id);
        open(mk, &sealed, aad.as_bytes())?
    };
    let text = String::from_utf8(plaintext).map_err(|_| ERR_BAD_FORMAT.to_string())?;
    state.finish_use(workspace_path);

    Ok(DecryptResult { plaintext: text })
}

/* ---------------------------------- tests ------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; KEY_LEN] {
        let mut key = [0u8; KEY_LEN];
        random_bytes(&mut key);
        key
    }

    #[test]
    fn seal_open_round_trip() {
        let key = test_key();
        let aad = block_aad(1, "k1", "b9f3a2c");
        let sealed = seal(&key, "机密内容".as_bytes(), aad.as_bytes()).unwrap();
        let opened = open(&key, &sealed, aad.as_bytes()).unwrap();
        assert_eq!(opened, "机密内容".as_bytes());
    }

    #[test]
    fn flipping_one_ciphertext_byte_is_rejected() {
        let key = test_key();
        let aad = block_aad(1, "k1", "b9f3a2c");
        let mut sealed = seal(&key, b"hello", aad.as_bytes()).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert_eq!(open(&key, &sealed, aad.as_bytes()).unwrap_err(), ERR_TAMPERED);
    }

    #[test]
    fn moving_a_block_to_another_id_is_rejected() {
        let key = test_key();
        let sealed = seal(&key, b"hello", block_aad(1, "k1", "b9f3a2c").as_bytes()).unwrap();
        // Same ciphertext, different block id — the AAD no longer matches.
        let moved = open(&key, &sealed, block_aad(1, "k1", "bdead01").as_bytes());
        assert_eq!(moved.unwrap_err(), ERR_TAMPERED);
        // And the same for a forged key id.
        let relabelled = open(&key, &sealed, block_aad(1, "k2", "b9f3a2c").as_bytes());
        assert_eq!(relabelled.unwrap_err(), ERR_TAMPERED);
    }

    #[test]
    fn a_different_key_cannot_open_it() {
        let aad = block_aad(1, "k1", "b9f3a2c");
        let sealed = seal(&test_key(), b"hello", aad.as_bytes()).unwrap();
        assert_eq!(
            open(&test_key(), &sealed, aad.as_bytes()).unwrap_err(),
            ERR_TAMPERED
        );
    }

    #[test]
    fn nonces_never_repeat_across_encryptions() {
        let key = test_key();
        let aad = block_aad(1, "k1", "b9f3a2c");
        let a = seal(&key, b"same plaintext", aad.as_bytes()).unwrap();
        let b = seal(&key, b"same plaintext", aad.as_bytes()).unwrap();
        assert_ne!(a[..NONCE_LEN], b[..NONCE_LEN]);
        assert_ne!(a, b);
    }

    /// Cheap Argon2 parameters. The real ones are deliberately slow, which is
    /// the point of them and also why no test may use them.
    const TEST_M: u32 = 32;
    const TEST_T: u32 = 1;

    #[test]
    fn slot_opens_with_its_own_secret_only() {
        let mut mk = [0u8; KEY_LEN];
        random_bytes(&mut mk);
        let slot = make_slot_with(
            "s1", "password", "主口令", "k1", "correct horse", &mk, TEST_M, TEST_T,
        )
        .unwrap();
        assert_eq!(try_slot(&slot, "correct horse").unwrap().unwrap().as_ref(), &mk);
        assert!(try_slot(&slot, "wrong horse").unwrap().is_none());
    }

    #[test]
    fn vault_file_round_trips_and_both_secrets_open_it() {
        // The end-to-end promise: one master key, wrapped twice, written to
        // disk in a form another device can read back and open with either the
        // password or the recovery code.
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let mut mk = [0u8; KEY_LEN];
        random_bytes(&mut mk);
        let recovery = base32(&[7u8; 15]);

        let written = VaultFile {
            version: VAULT_VERSION,
            active_key_id: "k1".into(),
            slots: vec![
                make_slot_with("s1", "password", "主口令", "k1", "correct horse", &mk, TEST_M, TEST_T)
                    .unwrap(),
                make_slot_with("s2", "recovery", "恢复码", "k1", &recovery, &mk, TEST_M, TEST_T)
                    .unwrap(),
            ],
            rotation: None,
        };
        write_vault(workspace, &written).unwrap();

        // vault.json must carry no plaintext key material.
        let raw = fs::read_to_string(vault_path(workspace)).unwrap();
        assert!(!raw.contains("correct horse"));
        assert!(!raw.contains(&recovery));
        assert!(!raw.contains(&STANDARD.encode(mk)));

        let reloaded = read_vault(workspace).unwrap().unwrap();
        assert_eq!(reloaded.slots.len(), 2);

        // The password opens slot 1; the recovery code — typed back in its
        // grouped, lowercase form — opens slot 2. Both yield the same MK.
        let by_password = try_slot(&reloaded.slots[0], "correct horse").unwrap().unwrap();
        let grouped = recovery
            .as_bytes()
            .chunks(6)
            .map(|c| String::from_utf8_lossy(c).to_lowercase())
            .collect::<Vec<_>>()
            .join("-");
        let by_recovery = try_slot(&reloaded.slots[1], &grouped).unwrap().unwrap();
        assert_eq!(by_password.as_ref(), &mk);
        assert_eq!(by_recovery.as_ref(), &mk);

        // Key-slot maintenance accepts either credential, not just the slot
        // that happens to be replaced.
        assert_eq!(
            open_key_from_slots(&reloaded.slots, "correct horse", "k1")
                .unwrap()
                .as_ref(),
            &mk
        );
        assert_eq!(
            open_key_from_slots(&reloaded.slots, &grouped, "k1")
                .unwrap()
                .as_ref(),
            &mk
        );
        assert_eq!(
            open_key_from_slots(&reloaded.slots, "wrong secret", "k1").unwrap_err(),
            ERR_WRONG_SECRET
        );

        // And a block encrypted under that MK opens after the round trip.
        let aad = block_aad(1, "k1", "b9f3a2c");
        let sealed = seal(&mk, "银行卡 6222…".as_bytes(), aad.as_bytes()).unwrap();
        let opened = open(&by_recovery, &sealed, aad.as_bytes()).unwrap();
        assert_eq!(opened, "银行卡 6222…".as_bytes());
    }

    fn encoded_secret(mk: &[u8; KEY_LEN], key_id: &str, block_id: &str, text: &str) -> String {
        let aad = block_aad(FORMAT_VERSION, key_id, block_id);
        URL_SAFE_NO_PAD.encode(seal(mk, text.as_bytes(), aad.as_bytes()).unwrap())
    }

    #[test]
    fn rotation_rewrites_block_and_inline_secrets_but_not_examples() {
        let old = test_key();
        let new = test_key();
        let block_body = encoded_secret(&old, "k1", "baaa111", "围栏明文");
        let inline_body = encoded_secret(&old, "k1", "baaa111", "行内明文");
        let note = format!(
            "标题\n```secret {{v=1, key=k1, id=baaa111, hint=银行卡}}\n{block_body}\n```\n行内 `secret {{v=1,key=k1,id=baaa111}} {inline_body}`。\n````markdown\n```secret {{v=1, key=k1, id=example}}\nAAAA\n```\n````"
        );
        let mut keys = HashMap::new();
        keys.insert("k1".into(), Zeroizing::new(old));
        let path = Path::new("note.md");
        let (rotated, count) = rotate_note_text(path, &note, &keys, "k2", &new).unwrap();
        assert_eq!(count, 2);
        assert!(rotated.contains("key=k2, id=baaa111, hint=银行卡"));
        assert!(rotated.contains("key=k2,id=baaa111"));
        assert!(rotated.contains("key=k1, id=example"));

        let spans = scan_secret_spans(&rotated).unwrap();
        assert_eq!(spans.len(), 2);
        for span in spans {
            let compact: String = rotated[span.body_from..span.body_to]
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            let sealed = URL_SAFE_NO_PAD.decode(compact).unwrap();
            let opened = open(
                &new,
                &sealed,
                block_aad(1, "k2", "baaa111").as_bytes(),
            )
            .unwrap();
            assert!(opened == "围栏明文".as_bytes() || opened == "行内明文".as_bytes());
        }
    }

    #[test]
    fn inline_secret_documentation_examples_are_ignored() {
        let old = test_key();
        let new = test_key();
        let body = encoded_secret(&old, "k1", "baaa111", "真实内容");
        let note = format!(
            "| **原始 `` `secret {{…}} …` ``** |\n语言名 `secret`\n扫描说明 `secret {{...}}`\n真实 `secret {{v=1, key=k1, id=baaa111}} {body}`"
        );
        let mut keys = HashMap::new();
        keys.insert("k1".into(), Zeroizing::new(old));

        let (rotated, count) =
            rotate_note_text(Path::new("documentation.md"), &note, &keys, "k2", &new).unwrap();
        assert_eq!(count, 1);
        assert!(rotated.contains("`` `secret {…} …` ``"));
        assert!(rotated.contains("语言名 `secret`"));
        assert!(rotated.contains("扫描说明 `secret {...}`"));
        assert!(rotated.contains("key=k2"));
    }

    #[test]
    fn malformed_secret_aborts_before_changing_text() {
        let old = test_key();
        let new = test_key();
        let mut keys = HashMap::new();
        keys.insert("k1".into(), Zeroizing::new(old));
        let malformed = "before\n```secret {v=1, key=k1}\nAAAA\n```\nafter";
        let error = rotate_note_text(Path::new("broken.md"), malformed, &keys, "k2", &new)
            .unwrap_err();
        assert!(error.contains("broken.md"));
        assert!(error.contains("格式无法识别"));

        let malformed_inline = "`secret {v=1, key=k1} AAAA`";
        let error = rotate_note_text(
            Path::new("broken-inline.md"),
            malformed_inline,
            &keys,
            "k2",
            &new,
        )
        .unwrap_err();
        assert!(error.contains("行内加密属性无法识别"));
    }

    #[test]
    fn unknown_and_tampered_secrets_fail_strict_preflight() {
        let old = test_key();
        let new = test_key();
        let body = encoded_secret(&old, "k1", "baaa111", "secret");
        let mut keys = HashMap::new();
        keys.insert("k1".into(), Zeroizing::new(old));

        let unknown = format!("`secret {{v=1, key=k9, id=baaa111}} {body}`");
        let content = &unknown[1..unknown.len() - 1];
        let brace = content.rfind('}').unwrap();
        assert!(parse_secret_info(&content[..=brace]).is_ok());
        assert!(content[brace + 1..]
            .trim_start_matches([' ', '\t'])
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        let scanned = scan_secret_spans(&unknown);
        assert!(scanned.is_ok(), "{:?}", scanned.as_ref().err());
        let error = rotate_note_text(Path::new("unknown.md"), &unknown, &keys, "k2", &new)
            .unwrap_err();
        assert!(error.contains("找不到密钥 k9"), "{error}");

        let mut broken = URL_SAFE_NO_PAD.decode(body.as_bytes()).unwrap();
        let last = broken.len() - 1;
        broken[last] ^= 1;
        let broken = URL_SAFE_NO_PAD.encode(broken);
        let tampered = format!("`secret {{v=1, key=k1, id=baaa111}} {broken}`");
        let error = rotate_note_text(Path::new("tampered.md"), &tampered, &keys, "k2", &new)
            .unwrap_err();
        assert!(error.contains("已损坏"));
    }

    #[test]
    fn rotation_output_round_trips_gbk_and_utf16() {
        let old = test_key();
        let new = test_key();
        let body = encoded_secret(&old, "k1", "baaa111", "编码内容");
        let note = format!(
            "{}\n```secret {{v=1, key=k1, id=baaa111}}\n{body}\n```\n",
            "这是一段用来稳定检测编码的中文笔记。".repeat(8)
        );
        let mut keys = HashMap::new();
        keys.insert("k1".into(), Zeroizing::new(old));

        let (gbk_bytes, _, had_errors) = encoding_rs::GBK.encode(&note);
        assert!(!had_errors);
        let (gbk_text, gbk_encoding) = crate::encoding::decode(gbk_bytes.into_owned()).unwrap();
        let (rotated, _) =
            rotate_note_text(Path::new("gbk.md"), &gbk_text, &keys, "k2", &new).unwrap();
        let (gbk_out, lossless) = crate::encoding::encode(&rotated, gbk_encoding);
        assert!(lossless);
        assert!(crate::encoding::decode(gbk_out).unwrap().0.contains("key=k2"));

        let (utf16, _) =
            crate::encoding::encode(&note, crate::encoding::FileEncoding::Utf16Le);
        let (utf16_text, utf16_encoding) = crate::encoding::decode(utf16).unwrap();
        let (rotated, _) =
            rotate_note_text(Path::new("utf16.md"), &utf16_text, &keys, "k2", &new).unwrap();
        let (utf16_out, lossless) = crate::encoding::encode(&rotated, utf16_encoding);
        assert!(lossless);
        assert!(utf16_out.starts_with(&[0xFF, 0xFE]));
        assert!(crate::encoding::decode(utf16_out).unwrap().0.contains("key=k2"));
    }

    #[test]
    fn full_rotation_keeps_password_replaces_recovery_and_preserves_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let password = "correct horse";
        let old_recovery = base32(&[4u8; 15]);
        let old_mk = test_key();
        let initial = VaultFile {
            version: VAULT_VERSION,
            active_key_id: "k1".into(),
            slots: vec![
                make_slot_with(
                    "s1", "password", "主口令", "k1", password, &old_mk, TEST_M, TEST_T,
                )
                .unwrap(),
                make_slot_with(
                    "s2", "recovery", "恢复码", "k1", &old_recovery, &old_mk, TEST_M, TEST_T,
                )
                .unwrap(),
            ],
            rotation: None,
        };
        write_vault(workspace, &initial).unwrap();

        let body = encoded_secret(&old_mk, "k1", "baaa111", "迁移后的内容");
        let note = format!("\u{feff}标题\r\n~~~secret {{v=1, key=k1, id=baaa111, hint=保留}}\r\n{body}\r\n~~~\r\n");
        let note_path = dir.path().join("note.markdown");
        fs::write(&note_path, note.as_bytes()).unwrap();
        let inline_path = dir.path().join("nested").join("inline.md");
        fs::create_dir_all(inline_path.parent().unwrap()).unwrap();
        fs::write(
            &inline_path,
            format!("重复 ID `secret {{v=1,key=k1,id=baaa111}} {body}`"),
        )
        .unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(
            dir.path().join(".git/ignored.md"),
            "```secret {v=1, key=missing}\nbad\n```",
        )
        .unwrap();

        let built =
            rotate_master_key_on_disk_with_cost(workspace, password, TEST_M, TEST_T).unwrap();
        assert_eq!(built.result.files_changed, 2);
        assert_eq!(built.result.secrets_changed, 2);
        assert_ne!(built.result.active_key_id, "k1");

        let final_vault = read_vault(workspace).unwrap().unwrap();
        assert!(final_vault.rotation.is_none());
        assert_eq!(final_vault.slots.len(), 2);
        assert!(final_vault
            .slots
            .iter()
            .all(|slot| slot.key_id == built.result.active_key_id));
        assert!(open_key_from_slots(
            &final_vault.slots,
            password,
            &built.result.active_key_id
        )
        .is_ok());
        assert_eq!(
            open_key_from_slots(
                &final_vault.slots,
                &old_recovery,
                &built.result.active_key_id
            )
            .unwrap_err(),
            ERR_WRONG_SECRET
        );
        assert!(open_key_from_slots(
            &final_vault.slots,
            &built.result.recovery_code,
            &built.result.active_key_id
        )
        .is_ok());

        let bytes = fs::read(note_path).unwrap();
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let (rotated, encoding) = crate::encoding::decode(bytes).unwrap();
        assert_eq!(encoding, crate::encoding::FileEncoding::Utf8Bom);
        assert!(rotated.contains("hint=保留"));
        assert!(rotated.contains("\r\n"));
        let span = scan_secret_spans(&rotated).unwrap().remove(0);
        assert_eq!(span.key_id, built.result.active_key_id);
        let compact: String = rotated[span.body_from..span.body_to]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        let sealed = URL_SAFE_NO_PAD.decode(compact).unwrap();
        let plaintext = open(
            &built.target_mk,
            &sealed,
            block_aad(1, &span.key_id, &span.block_id).as_bytes(),
        )
        .unwrap();
        assert_eq!(plaintext, "迁移后的内容".as_bytes());

        let inline = fs::read_to_string(inline_path).unwrap();
        let inline_span = scan_secret_spans(&inline).unwrap().remove(0);
        assert_eq!(inline_span.key_id, built.result.active_key_id);
        assert_eq!(inline_span.block_id, span.block_id);
    }

    #[test]
    fn rotation_preflight_failure_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let password = "correct horse";
        let old_mk = test_key();
        let initial = VaultFile {
            version: VAULT_VERSION,
            active_key_id: "k1".into(),
            slots: vec![make_slot_with(
                "s1", "password", "主口令", "k1", password, &old_mk, TEST_M, TEST_T,
            )
            .unwrap()],
            rotation: None,
        };
        write_vault(workspace, &initial).unwrap();
        let note_path = dir.path().join("broken.md");
        fs::write(&note_path, "```secret {v=1, key=k1}\nAAAA\n```\n").unwrap();
        let vault_before = fs::read(vault_path(workspace)).unwrap();
        let note_before = fs::read(&note_path).unwrap();

        let error = rotate_master_key_on_disk_with_cost(workspace, password, TEST_M, TEST_T)
            .err()
            .unwrap();
        assert!(error.contains("格式无法识别"));
        assert_eq!(fs::read(vault_path(workspace)).unwrap(), vault_before);
        assert_eq!(fs::read(note_path).unwrap(), note_before);
    }

    #[test]
    fn wrong_rotation_password_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let password = "correct horse";
        let old_mk = test_key();
        let initial = VaultFile {
            version: VAULT_VERSION,
            active_key_id: "k1".into(),
            slots: vec![make_slot_with(
                "s1", "password", "主口令", "k1", password, &old_mk, TEST_M, TEST_T,
            )
            .unwrap()],
            rotation: None,
        };
        write_vault(workspace, &initial).unwrap();
        let body = encoded_secret(&old_mk, "k1", "baaa111", "保持不变");
        let note_path = dir.path().join("note.md");
        fs::write(
            &note_path,
            format!("`secret {{v=1, key=k1, id=baaa111}} {body}`"),
        )
        .unwrap();
        let vault_before = fs::read(vault_path(workspace)).unwrap();
        let note_before = fs::read(&note_path).unwrap();

        let error = rotate_master_key_on_disk_with_cost(
            workspace,
            "definitely wrong",
            TEST_M,
            TEST_T,
        )
        .err()
        .unwrap();
        assert_eq!(error, ERR_WRONG_SECRET);
        assert_eq!(fs::read(vault_path(workspace)).unwrap(), vault_before);
        assert_eq!(fs::read(note_path).unwrap(), note_before);
    }

    #[test]
    fn pending_rotation_resumes_and_prunes_the_old_key() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let password = "correct horse";
        let old_mk = test_key();
        let target_mk = test_key();
        let transition = VaultFile {
            version: VAULT_VERSION,
            active_key_id: "k2".into(),
            slots: vec![
                make_slot_with(
                    "s1", "password", "主口令", "k1", password, &old_mk, TEST_M, TEST_T,
                )
                .unwrap(),
                make_slot_with(
                    "s3", "password", "主口令", "k2", password, &target_mk, TEST_M, TEST_T,
                )
                .unwrap(),
            ],
            rotation: Some(RotationState {
                target_key_id: "k2".into(),
                retired_key_ids: vec!["k1".into()],
                started_at: now_ms(),
            }),
        };
        write_vault(workspace, &transition).unwrap();
        let body = encoded_secret(&old_mk, "k1", "baaa111", "等待续跑");
        fs::write(
            dir.path().join("resume.md"),
            format!("`secret {{v=1, key=k1, id=baaa111}} {body}`\n"),
        )
        .unwrap();

        let built =
            rotate_master_key_on_disk_with_cost(workspace, password, TEST_M, TEST_T).unwrap();
        assert_eq!(built.result.active_key_id, "k2");
        assert_eq!(built.result.secrets_changed, 1);
        assert_eq!(built.target_mk.as_ref(), &target_mk);
        let final_vault = read_vault(workspace).unwrap().unwrap();
        assert!(final_vault.rotation.is_none());
        assert!(final_vault.slots.iter().all(|slot| slot.key_id == "k2"));
    }

    #[test]
    fn a_corrupt_vault_is_reported_not_replaced() {
        // Every encrypted block in the workspace depends on this file, so a
        // parse failure must surface instead of being treated as "no vault yet"
        // and silently overwritten.
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join(VAULT_DIR)).unwrap();
        fs::write(vault_path(workspace), "{ not json").unwrap();
        assert!(read_vault(workspace).is_err());
    }

    #[test]
    fn changing_the_password_keeps_the_same_master_key() {
        // The reason a password change never rewrites a single note.
        let mut mk = [0u8; KEY_LEN];
        random_bytes(&mut mk);
        let first =
            make_slot_with("s1", "password", "主口令", "k1", "old passphrase", &mk, TEST_M, TEST_T)
                .unwrap();
        let unwrapped = try_slot(&first, "old passphrase").unwrap().unwrap();
        let second = make_slot_with(
            "s1", "password", "主口令", "k1", "new passphrase", &unwrapped, TEST_M, TEST_T,
        )
        .unwrap();
        assert_eq!(try_slot(&second, "new passphrase").unwrap().unwrap().as_ref(), &mk);
        assert!(try_slot(&second, "old passphrase").unwrap().is_none());
    }

    #[test]
    fn recovery_code_ignores_grouping_and_case() {
        assert_eq!(
            normalize_recovery("abcdef-GHIJKL-mnopqr-STUVWX"),
            "ABCDEFGHIJKLMNOPQRSTUVWX"
        );
        assert_eq!(normalize_recovery("ABCDEF GHIJKL"), "ABCDEFGHIJKL");
    }

    #[test]
    fn base32_length_is_exact() {
        assert_eq!(base32(&[0u8; 15]).len(), 24);
    }

    const TEST_WORKSPACE_A: &str = "/workspace/a";
    const TEST_WORKSPACE_B: &str = "/workspace/b";

    fn insert_test_session(
        state: &mut VaultState,
        workspace: &str,
        key_byte: u8,
        unlocked_at: Instant,
    ) {
        let mut keys = HashMap::new();
        keys.insert("k1".into(), Zeroizing::new([key_byte; KEY_LEN]));
        state.sessions.insert(
            PathBuf::from(workspace),
            WorkspaceSession {
                keys,
                active_key_id: "k1".into(),
                unlocked_at: Some(unlocked_at),
            },
        );
    }

    /// Build a state whose A-workspace session was unlocked `ago` in the past.
    /// Returns None on a machine that has been up for less than `ago`, where
    /// the subtraction has nothing to land on.
    fn unlocked_since(ttl_minutes: i64, ago: Duration) -> Option<VaultState> {
        let last = Instant::now().checked_sub(ago)?;
        let mut state = VaultState {
            ttl_minutes,
            ..Default::default()
        };
        insert_test_session(&mut state, TEST_WORKSPACE_A, 7, last);
        Some(state)
    }

    #[test]
    fn a_key_survives_until_the_ttl_is_up() {
        let Some(mut state) = unlocked_since(15, Duration::from_secs(14 * 60)) else {
            return;
        };
        state.enforce_ttl();
        assert!(state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)));
        assert!(state
            .expires_in_secs(Path::new(TEST_WORKSPACE_A))
            .unwrap()
            <= 60);
    }

    #[test]
    fn a_key_is_dropped_once_the_ttl_passes() {
        let Some(mut state) = unlocked_since(15, Duration::from_secs(15 * 60 + 1)) else {
            return;
        };
        state.enforce_ttl();
        assert!(!state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)));
        assert_eq!(state.expires_in_secs(Path::new(TEST_WORKSPACE_A)), None);
        // The TTL is configuration, not session state — it must outlive the key.
        assert_eq!(state.ttl_minutes, 15);
    }

    #[test]
    fn watchdog_drops_an_expired_key_without_any_command() {
        let Some(mut state) = unlocked_since(0, Duration::ZERO) else {
            return;
        };
        let Some(expired_at) = Instant::now().checked_sub(Duration::from_secs(61)) else {
            return;
        };

        // Start with expiry disabled so the worker is sleeping without a
        // deadline, then give it an already-expired deadline and wake it. No
        // status/encrypt/decrypt command performs the cleanup for this test.
        state.ttl_minutes = 0;
        let vault = Arc::new(VaultInner {
            state: Mutex::new(state),
            expiry_changed: Condvar::new(),
        });
        vault.start_expiry_watchdog();

        {
            let mut state = vault.lock().unwrap();
            state.ttl_minutes = 1;
            state
                .sessions
                .get_mut(Path::new(TEST_WORKSPACE_A))
                .unwrap()
                .unlocked_at = Some(expired_at);
        }
        vault.notify_expiry_changed();

        let give_up = Instant::now() + Duration::from_secs(1);
        loop {
            if !vault
                .lock()
                .unwrap()
                .is_unlocked_for(Path::new(TEST_WORKSPACE_A))
            {
                break;
            }
            assert!(Instant::now() < give_up, "watchdog did not clear the MK");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn using_a_key_does_not_push_the_expiry_back() {
        let Some(mut state) = unlocked_since(15, Duration::from_secs(14 * 60)) else {
            return;
        };
        let before = state.next_expiry_in().unwrap();
        state.finish_use(Path::new(TEST_WORKSPACE_A));
        let after = state.next_expiry_in().unwrap();
        assert!(state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)));
        assert!(after <= before, "using the MK must not extend its deadline");
        assert!(after <= Duration::from_secs(60));
    }

    #[test]
    fn a_zero_ttl_never_expires() {
        let Some(mut state) = unlocked_since(0, Duration::from_secs(3600 * 24)) else {
            return;
        };
        state.enforce_ttl();
        assert!(state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)));
        assert_eq!(state.expires_in_secs(Path::new(TEST_WORKSPACE_A)), None);
    }

    #[test]
    fn immediate_expiry_keeps_the_key_until_the_work_is_done() {
        // enforce_ttl runs *before* the key is used, so it must not touch an
        // immediate-expiry key — otherwise the key would be gone between
        // unlocking and the first decrypt and could never be used at all.
        let Some(mut state) = unlocked_since(-1, Duration::from_secs(60)) else {
            return;
        };
        state.enforce_ttl();
        assert!(
            state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)),
            "key must survive until it has been used"
        );

        state.finish_use(Path::new(TEST_WORKSPACE_A));
        assert!(
            !state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)),
            "key must be gone once the work is done"
        );
        // Still configuration, not session state.
        assert_eq!(state.ttl_minutes, -1);
    }

    #[test]
    fn a_normal_ttl_keeps_the_original_unlock_deadline() {
        let Some(mut state) = unlocked_since(15, Duration::from_secs(14 * 60)) else {
            return;
        };
        state.finish_use(Path::new(TEST_WORKSPACE_A));
        assert!(state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)));
        assert!(state
            .expires_in_secs(Path::new(TEST_WORKSPACE_A))
            .unwrap()
            <= 60);
    }

    #[test]
    fn immediate_expiry_reports_no_countdown() {
        let Some(state) = unlocked_since(-1, Duration::from_secs(1)) else {
            return;
        };
        // There is no deadline to count down to; the UI must not schedule one.
        assert_eq!(state.expires_in_secs(Path::new(TEST_WORKSPACE_A)), None);
        assert!(state.expires_immediately());
    }

    #[test]
    fn workspaces_keep_independent_master_keys() {
        let now = Instant::now();
        let mut state = VaultState::default();
        insert_test_session(&mut state, TEST_WORKSPACE_A, 7, now);
        insert_test_session(&mut state, TEST_WORKSPACE_B, 9, now);

        let a = state.sessions.get(Path::new(TEST_WORKSPACE_A)).unwrap();
        let b = state.sessions.get(Path::new(TEST_WORKSPACE_B)).unwrap();
        // Both vaults normally call their first key "k1". The workspace path,
        // not key-id uniqueness, is what must keep these MKs apart.
        assert_eq!(a.active_key_id, b.active_key_id);
        assert_eq!(a.keys["k1"].as_ref(), &[7u8; KEY_LEN]);
        assert_eq!(b.keys["k1"].as_ref(), &[9u8; KEY_LEN]);
    }

    #[test]
    fn locking_one_workspace_keeps_the_other_unlocked() {
        let now = Instant::now();
        let mut state = VaultState::default();
        insert_test_session(&mut state, TEST_WORKSPACE_A, 7, now);
        insert_test_session(&mut state, TEST_WORKSPACE_B, 9, now);

        state.clear_workspace(Path::new(TEST_WORKSPACE_A));
        assert!(!state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)));
        assert!(state.is_unlocked_for(Path::new(TEST_WORKSPACE_B)));
        assert_eq!(
            state.sessions[Path::new(TEST_WORKSPACE_B)].keys["k1"].as_ref(),
            &[9u8; KEY_LEN]
        );
    }

    #[test]
    fn expiry_is_enforced_per_workspace() {
        let Some(expired_at) = Instant::now().checked_sub(Duration::from_secs(61)) else {
            return;
        };
        let mut state = VaultState {
            ttl_minutes: 1,
            ..Default::default()
        };
        insert_test_session(&mut state, TEST_WORKSPACE_A, 7, expired_at);
        insert_test_session(&mut state, TEST_WORKSPACE_B, 9, Instant::now());

        state.enforce_ttl();
        assert!(!state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)));
        assert!(state.is_unlocked_for(Path::new(TEST_WORKSPACE_B)));
    }

    #[test]
    fn immediate_expiry_finishes_only_the_workspace_that_was_used() {
        let now = Instant::now();
        let mut state = VaultState {
            ttl_minutes: -1,
            ..Default::default()
        };
        insert_test_session(&mut state, TEST_WORKSPACE_A, 7, now);
        insert_test_session(&mut state, TEST_WORKSPACE_B, 9, now);

        state.finish_use(Path::new(TEST_WORKSPACE_A));
        assert!(!state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)));
        assert!(state.is_unlocked_for(Path::new(TEST_WORKSPACE_B)));
    }

    #[test]
    fn master_key_rotation_always_ends_locked_regardless_of_ttl() {
        for ttl_minutes in [-1, 0, 15] {
            let mut state = VaultState {
                ttl_minutes,
                ..Default::default()
            };
            insert_test_session(&mut state, TEST_WORKSPACE_A, 7, Instant::now());
            let mut target_mk = Zeroizing::new([9u8; KEY_LEN]);

            lock_after_master_key_rotation(
                &mut state,
                Path::new(TEST_WORKSPACE_A),
                &mut target_mk,
            );

            assert!(!state.is_unlocked_for(Path::new(TEST_WORKSPACE_A)));
            assert_eq!(target_mk.as_ref(), &[0u8; KEY_LEN]);
            assert_eq!(state.ttl_minutes, ttl_minutes);
        }
    }

    #[test]
    fn the_default_ttl_is_fifteen_minutes() {
        assert_eq!(VaultState::default().ttl_minutes, 15);
    }

    #[test]
    fn aad_is_canonical_not_textual() {
        assert_eq!(block_aad(1, "k1", "b9f3a2c"), "v=1|key=k1|id=b9f3a2c");
    }

    #[test]
    fn block_ids_must_start_with_a_letter() {
        // Matches the IDENT rule the fence-attribute parser already enforces.
        assert!(valid_ident("b9f3a2c"));
        assert!(!valid_ident("9f3a2c"));
        assert!(!valid_ident(""));
        assert!(!valid_ident("has space"));
    }
}
