// Per-block note encryption.
//
// Two layers of keys, and the split is the whole point:
//
//   password ──Argon2id(salt)──> KEK ──unwrap──> MK ──> each ```secret block
//
// The MK is random and generated once per workspace; the password only ever
// wraps it. Changing the password rewraps the same MK, so it never rewrites a
// single note — which is what keeps a password change from turning into a
// repository-wide diff that every other device then has to merge.
//
// Slots work like LUKS key slots: several wrapped copies of the same MK, each
// openable by a different secret (the password, the recovery code, later a
// second password). Unlocking just tries them in turn — the Poly1305 tag *is*
// the "was that the right secret" test, so no password hash is ever stored.
//
// The MK never crosses the IPC boundary. Commands take plaintext and return
// ciphertext (or the reverse); nothing here returns key material, and nothing
// should ever be changed to.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::State;
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

/// How long the master key may sit in memory after it was last used. Sliding,
/// not absolute: working inside encrypted blocks keeps it alive, walking away
/// lets it expire.
///
/// Encoding, shared with the frontend setting:
///   -1 = drop the key the moment the operation that needed it finishes
///    0 = never expire
///   >0 = minutes of disuse
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
}

/* ------------------------------ session state --------------------------- */

pub struct VaultState {
    /// Which workspace the loaded keys belong to. Opening another workspace
    /// drops them rather than silently decrypting with the wrong vault.
    workspace: Option<PathBuf>,
    keys: HashMap<String, Zeroizing<[u8; KEY_LEN]>>,
    active_key_id: String,
    /// -1 = immediate, 0 = never, >0 = minutes of disuse.
    ttl_minutes: i64,
    /// When a key was last actually used. `None` while locked.
    last_used: Option<Instant>,
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            workspace: None,
            keys: HashMap::new(),
            active_key_id: String::new(),
            ttl_minutes: DEFAULT_TTL_MINUTES,
            last_used: None,
        }
    }
}

impl VaultState {
    /// Drop the key material. The TTL setting survives — it is configuration,
    /// not session state.
    fn clear_keys(&mut self) {
        for (_, mut key) in self.keys.drain() {
            key.zeroize();
        }
        self.active_key_id.clear();
        self.last_used = None;
    }

    fn clear(&mut self) {
        self.clear_keys();
        self.workspace = None;
    }

    /// True when the key must not outlive the operation that needed it.
    fn expires_immediately(&self) -> bool {
        self.ttl_minutes < 0
    }

    fn ttl(&self) -> Option<Duration> {
        (self.ttl_minutes > 0).then(|| Duration::from_secs(self.ttl_minutes as u64 * 60))
    }

    /// Drop the keys if they have gone unused for longer than the TTL.
    ///
    /// Enforced here, at every point of use, rather than by a timer in the UI:
    /// a timer can be missed, paused by a sleeping renderer, or simply never
    /// fire, and "the key expired" has to be true of the key, not of a clock
    /// someone else is watching.
    fn enforce_ttl(&mut self) {
        // Immediate expiry is not enforced here. This runs *before* the key is
        // used, so a zero-length idle window would drop it between unlocking
        // and the very first decrypt — the key would never be usable at all.
        // `finish_use` is what drops it, once the work is actually done.
        let (Some(ttl), Some(last)) = (self.ttl(), self.last_used) else {
            return;
        };
        if last.elapsed() >= ttl {
            self.clear_keys();
        }
    }

    fn touch(&mut self) {
        self.last_used = Some(Instant::now());
    }

    /// Called after a command has finished with the key: under immediate expiry
    /// the key goes away right now, otherwise the idle timer simply restarts.
    ///
    /// Commands that need the key more than once (a save re-encrypting several
    /// blocks) must do all of it before calling this, which is why encryption
    /// is batched into one command rather than one call per block.
    fn finish_use(&mut self) {
        if self.expires_immediately() {
            self.clear_keys();
        } else {
            self.touch();
        }
    }

    /// Seconds until the keys expire, for the UI's countdown.
    fn expires_in_secs(&self) -> Option<u64> {
        let (ttl, last) = (self.ttl()?, self.last_used?);
        Some(ttl.saturating_sub(last.elapsed()).as_secs())
    }

    fn is_unlocked_for(&self, workspace: &Path) -> bool {
        self.workspace.as_deref() == Some(workspace) && !self.keys.is_empty()
    }
}

pub type Vault = Mutex<VaultState>;

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

fn write_vault(workspace: &str, vault: &VaultFile) -> Result<(), String> {
    let path = vault_path(workspace);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(vault).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn random_bytes(out: &mut [u8]) {
    rand::rngs::OsRng.fill_bytes(out);
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
    /// -1 = immediate, 0 = never, >0 = minutes of disuse.
    pub ttl_minutes: i64,
    /// Seconds left on that timer, so the UI can schedule its own re-check
    /// instead of polling. None while locked or when expiry is off.
    pub expires_in_secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    /// Shown once. There is no second chance to read it out of anywhere.
    pub recovery_code: String,
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
    // Switching workspaces drops the keys instead of leaving them available to
    // a vault they don't belong to.
    if let Some(loaded) = state.workspace.clone() {
        if loaded != Path::new(&workspace) {
            state.clear();
        }
    }
    let Some(file) = file else {
        return Ok(VaultStatus {
            initialized: false,
            locked: true,
            active_key_id: String::new(),
            slots: Vec::new(),
            ttl_minutes: state.ttl_minutes,
            expires_in_secs: None,
        });
    };
    Ok(VaultStatus {
        initialized: true,
        locked: !state.is_unlocked_for(Path::new(&workspace)),
        ttl_minutes: state.ttl_minutes,
        expires_in_secs: state.expires_in_secs(),
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
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.clear();
    state.workspace = Some(PathBuf::from(&workspace));
    state.active_key_id = key_id.into();
    state.keys.insert(key_id.into(), mk);
    state.touch();

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

    if keys.is_empty() {
        // Which slot came closest is deliberately not reported.
        return Err(ERR_WRONG_SECRET.to_string());
    }
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.clear();
    state.workspace = Some(PathBuf::from(&workspace));
    state.active_key_id = active_key_id;
    state.keys = keys;
    state.touch();
    Ok(())
}

/// Change how long the key may linger. Takes effect immediately: shortening it
/// below the current idle time expires the key on the next use.
#[tauri::command]
pub fn vault_set_ttl(minutes: i64, vault: State<'_, Vault>) -> Result<(), String> {
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.ttl_minutes = minutes;
    state.enforce_ttl();
    Ok(())
}

#[tauri::command]
pub fn vault_lock(vault: State<'_, Vault>) -> Result<(), String> {
    vault.lock().map_err(|_| "vault state poisoned")?.clear();
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

#[tauri::command]
pub fn secret_encrypt(
    block_id: String,
    plaintext: String,
    vault: State<'_, Vault>,
) -> Result<EncryptResult, String> {
    if !valid_ident(&block_id) {
        return Err(ERR_BAD_FORMAT.to_string());
    }
    let mut state = vault.lock().map_err(|_| "vault state poisoned")?;
    state.enforce_ttl();
    let key_id = state.active_key_id.clone();
    let mk = state.keys.get(&key_id).ok_or(ERR_LOCKED)?;

    let aad = block_aad(FORMAT_VERSION, &key_id, &block_id);
    let sealed = seal(mk, plaintext.as_bytes(), aad.as_bytes())?;
    state.finish_use();

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
    let key_id = state.active_key_id.clone();
    let mk = state.keys.get(&key_id).ok_or(ERR_LOCKED)?;

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
    state.finish_use();
    Ok(out)
}

#[tauri::command]
pub fn secret_decrypt(
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
    if state.keys.is_empty() {
        return Err(ERR_LOCKED.to_string());
    }
    // A block written before a key rotation names the older key; missing it is
    // a different failure from a bad password, and the UI says so.
    let mk = state
        .keys
        .get(&key_id)
        .ok_or_else(|| ERR_UNKNOWN_KEY.to_string())?;

    // Whitespace inside the fence body is layout (the editor wraps long
    // ciphertext), so it is stripped before decoding rather than treated as
    // corruption.
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let sealed = URL_SAFE_NO_PAD
        .decode(compact.as_bytes())
        .map_err(|_| ERR_BAD_FORMAT.to_string())?;

    let aad = block_aad(v, &key_id, &block_id);
    let plaintext = open(mk, &sealed, aad.as_bytes())?;
    let text = String::from_utf8(plaintext).map_err(|_| ERR_BAD_FORMAT.to_string())?;
    state.finish_use();

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

    /// Build an unlocked state whose key was last used `ago` in the past.
    /// Returns None on a machine that has been up for less than `ago`, where
    /// the subtraction has nothing to land on.
    fn unlocked_since(ttl_minutes: i64, ago: Duration) -> Option<VaultState> {
        let last = Instant::now().checked_sub(ago)?;
        let mut state = VaultState {
            ttl_minutes,
            last_used: Some(last),
            ..Default::default()
        };
        state.active_key_id = "k1".into();
        state.keys.insert("k1".into(), Zeroizing::new([7u8; KEY_LEN]));
        Some(state)
    }

    #[test]
    fn a_key_survives_until_the_ttl_is_up() {
        let Some(mut state) = unlocked_since(15, Duration::from_secs(14 * 60)) else {
            return;
        };
        state.enforce_ttl();
        assert!(!state.keys.is_empty());
        assert!(state.expires_in_secs().unwrap() <= 60);
    }

    #[test]
    fn a_key_is_dropped_once_the_ttl_passes() {
        let Some(mut state) = unlocked_since(15, Duration::from_secs(15 * 60 + 1)) else {
            return;
        };
        state.enforce_ttl();
        assert!(state.keys.is_empty());
        assert!(state.active_key_id.is_empty());
        assert_eq!(state.expires_in_secs(), None);
        // The TTL is configuration, not session state — it must outlive the key.
        assert_eq!(state.ttl_minutes, 15);
    }

    #[test]
    fn using_a_key_pushes_the_expiry_back() {
        // The timer slides: working inside encrypted blocks keeps the key
        // alive, walking away is what lets it go.
        let Some(mut state) = unlocked_since(15, Duration::from_secs(14 * 60)) else {
            return;
        };
        state.touch();
        state.enforce_ttl();
        assert!(!state.keys.is_empty());
        assert!(state.expires_in_secs().unwrap() > 14 * 60);
    }

    #[test]
    fn a_zero_ttl_never_expires() {
        let Some(mut state) = unlocked_since(0, Duration::from_secs(3600 * 24)) else {
            return;
        };
        state.enforce_ttl();
        assert!(!state.keys.is_empty());
        assert_eq!(state.expires_in_secs(), None);
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
        assert!(!state.keys.is_empty(), "key must survive until it has been used");

        state.finish_use();
        assert!(state.keys.is_empty(), "key must be gone once the work is done");
        assert!(state.active_key_id.is_empty());
        // Still configuration, not session state.
        assert_eq!(state.ttl_minutes, -1);
    }

    #[test]
    fn a_normal_ttl_restarts_the_timer_instead_of_dropping_the_key() {
        let Some(mut state) = unlocked_since(15, Duration::from_secs(14 * 60)) else {
            return;
        };
        state.finish_use();
        assert!(!state.keys.is_empty());
        assert!(state.expires_in_secs().unwrap() > 14 * 60);
    }

    #[test]
    fn immediate_expiry_reports_no_countdown() {
        let Some(state) = unlocked_since(-1, Duration::from_secs(1)) else {
            return;
        };
        // There is no deadline to count down to; the UI must not schedule one.
        assert_eq!(state.expires_in_secs(), None);
        assert!(state.expires_immediately());
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
