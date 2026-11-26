//! HTTP calls for the Grsai API, made from Rust so connections are pooled and
//! so the caller can tell "never sent" apart from "sent, outcome unknown".
//!
//! `api_download` uses atomic `.part` staging files, bounded download concurrency,
//! automatic retry with HTTP `Range` resume on mid-stream drops, `Content-Length`
//! verification, and container/format structural integrity checks (PNG IEND, JPEG EOI,
//! GIF trailer, WebP RIFF size, SVG closing tag, MP4 box bounds) so truncated 4K images
//! or 2K videos are never promoted as completed results.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use reqwest::{Client, Method, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::{io::AsyncWriteExt, sync::Semaphore};

/// Maximum concurrent result downloads to prevent saturating bandwidth/proxies when
/// multiple parallel generation tasks finish at the same time.
const MAX_CONCURRENT_DOWNLOADS: usize = 4;
const MAX_DOWNLOAD_ATTEMPTS: usize = 4;
const RETRY_DELAYS_MS: [u64; 3] = [600, 1500, 3000];

static TEMP_FILE_SEQ: AtomicU64 = AtomicU64::new(1);

/// What became of one HTTP call. Network trouble is reported here instead of
/// as a bare error string, so the caller never has to parse messages.
#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum HttpOutcome {
    /// The server answered. `body` is the response text, empty for downloads.
    Responded { status: u16, body: String },
    /// The request never left this machine: bad URL, DNS failure, connection
    /// refused, connect timeout. Retrying cannot create a duplicate task.
    NotSent { message: String },
    /// The request went out but no answer came back: read timeout or a dropped
    /// connection. The server may or may not have acted on it.
    Unknown { message: String, status: Option<u16> },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    /// Timeouts in seconds, with the same meaning as in Python's `requests`:
    /// one for connecting, one per read.
    connect_timeout_secs: u64,
    read_timeout_secs: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSpec {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    connect_timeout_secs: u64,
    read_timeout_secs: u64,
    /// Where to store the file. It is promoted atomically only after full verification.
    dest_path: String,
}

pub struct ApiState {
    /// One client per timeout pair; each keeps its own connection pool alive between calls.
    clients: Mutex<HashMap<(u64, u64), Client>>,
    /// Bounds concurrent large-file downloads across parallel tasks.
    download_semaphore: Arc<Semaphore>,
}

impl Default for ApiState {
    fn default() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            download_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS)),
        }
    }
}

impl ApiState {
    fn client(&self, connect_timeout_secs: u64, read_timeout_secs: u64) -> Result<Client, HttpOutcome> {
        let key = (connect_timeout_secs, read_timeout_secs);
        let mut clients = self.clients.lock().map_err(|_| HttpOutcome::NotSent {
            message: "HTTP client cache is poisoned".to_string(),
        })?;
        if let Some(client) = clients.get(&key) {
            return Ok(client.clone());
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(connect_timeout_secs))
            .read_timeout(Duration::from_secs(read_timeout_secs))
            .build()
            .map_err(|error| HttpOutcome::NotSent {
                message: error.to_string(),
            })?;
        clients.insert(key, client.clone());
        Ok(client)
    }
}

/// reqwest 的 Display 只给一句话，真正的原因藏在 source 链里。把整条链拼出来，
/// 排查网络问题时才看得到是握手、超时还是连接被断。
fn describe(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// A failure before the server answered. Anything that is not a client-building
/// or connecting error happened after the request was on the wire.
fn classify(error: reqwest::Error) -> HttpOutcome {
    if error.is_builder() || error.is_connect() {
        HttpOutcome::NotSent {
            message: describe(&error),
        }
    } else {
        HttpOutcome::Unknown {
            message: describe(&error),
            status: error.status().map(|status| status.as_u16()),
        }
    }
}

fn build(
    client: Client,
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    body: Option<String>,
) -> Result<RequestBuilder, HttpOutcome> {
    let method = Method::from_str(method).map_err(|error| HttpOutcome::NotSent {
        message: error.to_string(),
    })?;
    let mut request = client.request(method, url);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    Ok(request)
}

async fn send(request: RequestBuilder) -> Result<Response, HttpOutcome> {
    request.send().await.map_err(classify)
}

/// Network trouble is part of the normal answer, so both commands always resolve with
/// an `HttpOutcome`, failed request included. A rejected promise therefore means the
/// invocation itself was broken (bad arguments, a panic), never a network problem.
#[tauri::command]
pub async fn api_request(
    state: State<'_, ApiState>,
    spec: RequestSpec,
) -> Result<HttpOutcome, String> {
    Ok(match request_outcome(&state, spec).await {
        Ok(outcome) => outcome,
        Err(outcome) => outcome,
    })
}

#[tauri::command]
pub async fn api_download(
    state: State<'_, ApiState>,
    spec: DownloadSpec,
) -> Result<HttpOutcome, String> {
    Ok(match download_outcome(&state, spec).await {
        Ok(outcome) => outcome,
        Err(outcome) => outcome,
    })
}

/// Sends a lightweight `HEAD` request to check whether the CDN exposes an explicit
/// SHA-256 checksum header (`x-amz-checksum-sha256`, `x-checksum-sha256`, `content-sha256`).
/// Returns `Ok(Some(lowercase_hex_64))` if available, or `Ok(None)` otherwise.
#[tauri::command]
pub async fn api_probe_remote_sha256(
    state: State<'_, ApiState>,
    url: String,
) -> Result<Option<String>, String> {
    let client = match state.client(8, 8) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let response = match client.head(&url).send().await {
        Ok(resp) if resp.status().is_success() => resp,
        _ => return Ok(None),
    };
    let headers = response.headers();
    for name in [
        "x-amz-checksum-sha256",
        "x-checksum-sha256",
        "content-sha256",
        "x-content-sha256",
    ] {
        if let Some(val) = headers.get(name).and_then(|v| v.to_str().ok()) {
            if let Some(hex) = normalize_sha256_header(val) {
                return Ok(Some(hex));
            }
        }
    }
    Ok(None)
}

fn normalize_sha256_header(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(trimmed.to_ascii_lowercase());
    }
    if let Some(bytes) = decode_base64_32(trimmed) {
        use std::fmt::Write;
        let mut hex = String::with_capacity(64);
        for byte in bytes {
            let _ = write!(&mut hex, "{byte:02x}");
        }
        return Some(hex);
    }
    None
}

fn decode_base64_32(input: &str) -> Option<[u8; 32]> {
    let bytes = input.as_bytes();
    if bytes.len() != 44 || bytes[43] != b'=' {
        return None;
    }
    let val = |b: u8| -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = [0u8; 32];
    let mut oi = 0usize;
    for chunk in bytes.chunks_exact(4) {
        let a = val(chunk[0])?;
        let b = val(chunk[1])?;
        if chunk[2] == b'=' {
            return None;
        }
        let c = val(chunk[2])?;
        out[oi] = (a << 2) | (b >> 4);
        oi += 1;
        out[oi] = (b << 4) | (c >> 2);
        oi += 1;
        if chunk[3] != b'=' {
            let d = val(chunk[3])?;
            out[oi] = (c << 6) | d;
            oi += 1;
        }
    }
    if oi == 32 { Some(out) } else { None }
}

async fn request_outcome(
    state: &ApiState,
    spec: RequestSpec,
) -> Result<HttpOutcome, HttpOutcome> {
    let client = state.client(spec.connect_timeout_secs, spec.read_timeout_secs)?;
    let request = build(client, &spec.method, &spec.url, &spec.headers, spec.body)?;
    let response = send(request).await?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| HttpOutcome::Unknown {
        message: error.to_string(),
        status: Some(status),
    })?;
    Ok(HttpOutcome::Responded { status, body })
}

fn make_part_path(dest: &Path) -> PathBuf {
    let seq = TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let mut os = dest.as_os_str().to_os_string();
    os.push(format!(".part.{pid}.{seq}"));
    PathBuf::from(os)
}

fn is_retryable_status(status: u16) -> bool {
    status == 408 || status == 429 || (500..600).contains(&status)
}

fn parse_content_range_start(header_val: &str) -> Option<(u64, Option<u64>)> {
    // Format: "bytes <start>-<end>/<total>" or "bytes <start>-<end>/*"
    let rest = header_val.trim().strip_prefix("bytes ")?;
    let (range_part, total_part) = rest.split_once('/')?;
    let (start_str, _end_str) = range_part.split_once('-')?;
    let start = start_str.trim().parse::<u64>().ok()?;
    let total = if total_part.trim() == "*" {
        None
    } else {
        total_part.trim().parse::<u64>().ok()
    };
    Some((start, total))
}

async fn promote_temp_file(temp: &Path, dest: &Path) -> Result<(), String> {
    // On Windows `tokio::fs::rename` fails when `dest` already exists; remove first.
    match tokio::fs::remove_file(dest).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("Failed to replace existing file: {err}")),
    }
    tokio::fs::rename(temp, dest)
        .await
        .map_err(|err| format!("Failed to finalize downloaded file: {err}"))
}

async fn download_outcome(
    state: &ApiState,
    spec: DownloadSpec,
) -> Result<HttpOutcome, HttpOutcome> {
    let _permit = state
        .download_semaphore
        .acquire()
        .await
        .map_err(|_| HttpOutcome::Unknown {
            message: "Download semaphore closed".to_string(),
            status: None,
        })?;

    let client = state.client(spec.connect_timeout_secs, spec.read_timeout_secs)?;
    let dest = Path::new(&spec.dest_path);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| HttpOutcome::Unknown {
                message: error.to_string(),
                status: None,
            })?;
    }

    let temp_path = make_part_path(dest);
    let mut expected_total: Option<u64> = None;
    let mut can_resume = false;
    let mut written: u64 = 0;
    let mut last_error: Option<HttpOutcome> = None;

    for attempt in 1..=MAX_DOWNLOAD_ATTEMPTS {
        if attempt > 1 {
            let delay_ms = RETRY_DELAYS_MS[(attempt - 2).min(RETRY_DELAYS_MS.len() - 1)];
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }

        let resuming = written > 0 && can_resume && expected_total.is_some();
        let mut req_headers = spec.headers.clone();
        if resuming {
            req_headers.insert("Range".to_string(), format!("bytes={written}-"));
        }

        let request = match build(client.clone(), "GET", &spec.url, &req_headers, None) {
            Ok(req) => req,
            Err(outcome) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(outcome);
            }
        };

        let mut response = match send(request).await {
            Ok(resp) => resp,
            Err(outcome) => {
                last_error = Some(outcome);
                continue;
            }
        };

        let status = response.status().as_u16();
        if status == 416 && resuming {
            // Range no longer satisfiable: reset partial file and restart cleanly from byte 0.
            let _ = tokio::fs::remove_file(&temp_path).await;
            written = 0;
            expected_total = None;
            can_resume = false;
            last_error = Some(HttpOutcome::Unknown {
                message: "HTTP 416 Range Not Satisfiable".to_string(),
                status: Some(status),
            });
            continue;
        }

        if !(200..300).contains(&status) {
            let body = response.text().await.unwrap_or_default();
            if is_retryable_status(status) && attempt < MAX_DOWNLOAD_ATTEMPTS {
                last_error = Some(HttpOutcome::Responded { status, body });
                continue;
            }
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Ok(HttpOutcome::Responded { status, body });
        }

        let mut append_mode = false;
        if resuming && status == 206 {
            let range_ok = response
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .and_then(parse_content_range_start)
                .map(|(start, total)| {
                    if let Some(t) = total {
                        expected_total = Some(t);
                    }
                    start == written
                })
                .unwrap_or(false);
            if range_ok {
                append_mode = true;
            }
        }

        if !append_mode {
            written = 0;
            expected_total = response.content_length();
            can_resume = response
                .headers()
                .get("accept-ranges")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_ascii_lowercase().contains("bytes"))
                .unwrap_or(false);
        }

        let file_res = if append_mode {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(&temp_path)
                .await
        } else {
            tokio::fs::File::create(&temp_path).await
        };
        let file = match file_res {
            Ok(f) => f,
            Err(error) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(HttpOutcome::Unknown {
                    message: error.to_string(),
                    status: Some(status),
                });
            }
        };

        let mut writer = tokio::io::BufWriter::with_capacity(512 * 1024, file);
        let mut stream_err: Option<String> = None;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if let Err(err) = writer.write_all(&chunk).await {
                        stream_err = Some(err.to_string());
                        break;
                    }
                    written += chunk.len() as u64;
                }
                Ok(None) => break,
                Err(err) => {
                    stream_err = Some(describe(&err));
                    break;
                }
            }
        }
        if let Err(err) = writer.flush().await {
            stream_err.get_or_insert_with(|| err.to_string());
        }
        drop(writer);

        if let Some(message) = stream_err {
            if !(can_resume && expected_total.is_some() && written > 0) {
                let _ = tokio::fs::remove_file(&temp_path).await;
                written = 0;
            }
            last_error = Some(HttpOutcome::Unknown {
                message,
                status: Some(status),
            });
            continue;
        }

        // Check 1: Non-empty response
        if written == 0 {
            let _ = tokio::fs::remove_file(&temp_path).await;
            expected_total = None;
            last_error = Some(HttpOutcome::Unknown {
                message: "Downloaded file is empty (0 bytes)".to_string(),
                status: Some(status),
            });
            continue;
        }

        // Check 2: Exact Content-Length verification (catches silent mid-stream drops)
        if let Some(expected) = expected_total {
            if written != expected {
                if written < expected && can_resume {
                    // Keep partial bytes and resume from `written` on next attempt!
                } else {
                    let _ = tokio::fs::remove_file(&temp_path).await;
                    written = 0;
                    expected_total = None;
                }
                last_error = Some(HttpOutcome::Unknown {
                    message: format!("Incomplete download: received {written} of {expected} bytes"),
                    status: Some(status),
                });
                continue;
            }
        }

        // Check 3: Format/container structural integrity verification (PNG IEND, JPEG EOI, GIF, WebP, SVG, MP4)
        let verify_temp = temp_path.clone();
        let verify_dest = dest.to_path_buf();
        let verify_result = tauri::async_runtime::spawn_blocking(move || {
            verify_media_integrity(&verify_temp, &verify_dest)
        })
        .await
        .map_err(|err| HttpOutcome::Unknown {
            message: err.to_string(),
            status: Some(status),
        })?;

        if let Err(reason) = verify_result {
            let _ = tokio::fs::remove_file(&temp_path).await;
            written = 0;
            expected_total = None;
            can_resume = false;
            last_error = Some(HttpOutcome::Unknown {
                message: format!("Downloaded media integrity check failed: {reason}"),
                status: Some(status),
            });
            continue;
        }

        // All checks passed: promote atomically to final destination.
        match promote_temp_file(&temp_path, dest).await {
            Ok(()) => {
                return Ok(HttpOutcome::Responded {
                    status: 200,
                    body: String::new(),
                });
            }
            Err(message) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(HttpOutcome::Unknown {
                    message,
                    status: Some(status),
                });
            }
        }
    }

    let _ = tokio::fs::remove_file(&temp_path).await;
    Err(last_error.unwrap_or_else(|| HttpOutcome::Unknown {
        message: "Download failed after retries".to_string(),
        status: None,
    }))
}

/// Verifies structural completeness of downloaded image/video files based on magic bytes
/// (with extension fallback). Prevents truncated files (e.g., partial 4K PNG missing IEND
/// or truncated 2K MP4) from ever being saved as valid results.
fn verify_media_integrity(file_path: &Path, dest_hint: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(file_path).map_err(|e| e.to_string())?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    if file_len == 0 {
        return Err("empty file".to_string());
    }

    let mut head = [0u8; 16];
    let head_read = file.read(&mut head).map_err(|e| e.to_string())?;
    let header = &head[..head_read];

    let ext = dest_hint
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    // 1. PNG: magic \x89PNG\r\n\x1a\n + walk chunks cleanly to IEND
    if header.starts_with(b"\x89PNG\r\n\x1a\n") || ext == "png" {
        if header.len() < 8 || &header[..8] != b"\x89PNG\r\n\x1a\n" {
            return Err("invalid PNG header".to_string());
        }
        let mut pos: u64 = 8;
        let mut found_iend = false;
        let mut chunk_hdr = [0u8; 8];
        while pos + 12 <= file_len {
            file.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
            file.read_exact(&mut chunk_hdr).map_err(|e| e.to_string())?;
            let chunk_len = u32::from_be_bytes([chunk_hdr[0], chunk_hdr[1], chunk_hdr[2], chunk_hdr[3]]) as u64;
            let chunk_type = &chunk_hdr[4..8];
            let next_pos = pos
                .checked_add(12)
                .and_then(|v| v.checked_add(chunk_len))
                .ok_or_else(|| "PNG chunk length overflow".to_string())?;
            if next_pos > file_len {
                return Err(format!(
                    "truncated PNG chunk ({:?}): needs {next_pos} bytes, file has {file_len}",
                    String::from_utf8_lossy(chunk_type)
                ));
            }
            if chunk_type == b"IEND" {
                found_iend = true;
                break;
            }
            pos = next_pos;
        }
        if !found_iend {
            return Err("truncated PNG: missing IEND chunk".to_string());
        }
        return Ok(());
    }

    // 2. JPEG: starts with FF D8, contains EOI FF D9 near end
    if header.starts_with(&[0xFF, 0xD8]) || ext == "jpg" || ext == "jpeg" {
        if header.len() < 2 || header[0] != 0xFF || header[1] != 0xD8 {
            return Err("invalid JPEG header".to_string());
        }
        let tail_len = file_len.min(64) as usize;
        file.seek(SeekFrom::Start(file_len - tail_len as u64))
            .map_err(|e| e.to_string())?;
        let mut tail = vec![0u8; tail_len];
        file.read_exact(&mut tail).map_err(|e| e.to_string())?;
        let has_eoi = tail.windows(2).any(|w| w == [0xFF, 0xD9]);
        if !has_eoi {
            return Err("truncated JPEG: missing EOI marker".to_string());
        }
        return Ok(());
    }

    // 3. GIF: starts with GIF87a/GIF89a, ends with 0x3B trailer
    if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") || ext == "gif" {
        if header.len() < 6 || (&header[..6] != b"GIF87a" && &header[..6] != b"GIF89a") {
            return Err("invalid GIF header".to_string());
        }
        let tail_len = file_len.min(16) as usize;
        file.seek(SeekFrom::Start(file_len - tail_len as u64))
            .map_err(|e| e.to_string())?;
        let mut tail = vec![0u8; tail_len];
        file.read_exact(&mut tail).map_err(|e| e.to_string())?;
        if !tail.contains(&0x3B) {
            return Err("truncated GIF: missing 0x3B trailer".to_string());
        }
        return Ok(());
    }

    // 4. WebP: RIFF <u32_le size> WEBP, file_len >= size + 8
    if (header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP") || ext == "webp" {
        if header.len() < 12 || &header[..4] != b"RIFF" || &header[8..12] != b"WEBP" {
            return Err("invalid WebP header".to_string());
        }
        let riff_size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as u64;
        if file_len < riff_size + 8 {
            return Err(format!(
                "truncated WebP: declared {} bytes, file has {file_len}",
                riff_size + 8
            ));
        }
        return Ok(());
    }

    // 5. SVG: must contain </svg>
    if ext == "svg" {
        let mut content = String::new();
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        file.read_to_string(&mut content).map_err(|e| e.to_string())?;
        let lower = content.to_ascii_lowercase();
        if !lower.contains("<svg") || !lower.contains("</svg>") {
            return Err("truncated SVG: missing closing </svg> tag".to_string());
        }
        return Ok(());
    }

    // 6. MP4 / MOV / M4V (ISO BMFF): walk top-level boxes and ensure no box is truncated past EOF
    if ext == "mp4" || ext == "mov" || ext == "m4v" {
        if file_len < 16 {
            return Err("truncated MP4: file too small".to_string());
        }
        let mut pos: u64 = 0;
        let mut boxes = 0usize;
        let mut box_hdr = [0u8; 8];
        while pos < file_len {
            if pos + 8 > file_len {
                return Err("truncated MP4 box header".to_string());
            }
            file.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
            file.read_exact(&mut box_hdr).map_err(|e| e.to_string())?;
            let size32 = u32::from_be_bytes([box_hdr[0], box_hdr[1], box_hdr[2], box_hdr[3]]) as u64;
            let box_size = if size32 == 0 {
                // Extends to EOF per ISO 14496-12
                file_len - pos
            } else if size32 == 1 {
                if pos + 16 > file_len {
                    return Err("truncated MP4 64-bit box header".to_string());
                }
                let mut ext_size = [0u8; 8];
                file.read_exact(&mut ext_size).map_err(|e| e.to_string())?;
                let s64 = u64::from_be_bytes(ext_size);
                if s64 < 16 {
                    return Err("invalid MP4 64-bit box size".to_string());
                }
                s64
            } else if size32 < 8 {
                return Err(format!("invalid MP4 box size {size32}"));
            } else {
                size32
            };
            let next_pos = pos
                .checked_add(box_size)
                .ok_or_else(|| "MP4 box size overflow".to_string())?;
            if next_pos > file_len {
                return Err(format!(
                    "truncated MP4 box ({:?}): needs {next_pos} bytes, file has {file_len}",
                    String::from_utf8_lossy(&box_hdr[4..8])
                ));
            }
            boxes += 1;
            pos = next_pos;
        }
        if boxes == 0 {
            return Err("MP4 contains no boxes".to_string());
        }
        return Ok(());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join("grsai_api_integrity_tests");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path
    }

    #[test]
    fn png_integrity_accepts_complete_and_rejects_truncated() {
        // Minimal valid PNG structure: magic + IHDR (13 bytes) + IDAT (4 bytes) + IEND (0 bytes)
        let mut png = Vec::new();
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0u8; 13]);
        png.extend_from_slice(&[0u8; 4]); // CRC
        png.extend_from_slice(&4u32.to_be_bytes());
        png.extend_from_slice(b"IDAT");
        png.extend_from_slice(&[1, 2, 3, 4]);
        png.extend_from_slice(&[0u8; 4]);
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0u8; 4]);

        let ok_path = write_temp("ok.png", &png);
        assert!(verify_media_integrity(&ok_path, &ok_path).is_ok());

        // Truncated right before IEND (simulates partial 4K PNG top-strip download!)
        let cut_path = write_temp("cut.png", &png[..png.len() - 6]);
        assert!(verify_media_integrity(&cut_path, &cut_path).is_err());

        // Truncated inside IDAT
        let cut2_path = write_temp("cut2.png", &png[..35]);
        assert!(verify_media_integrity(&cut2_path, &cut2_path).is_err());
    }

    #[test]
    fn jpeg_webp_gif_svg_mp4_integrity_checks() {
        let jpg_ok = write_temp("ok.jpg", &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02, 0xFF, 0xD9]);
        let jpg_bad = write_temp("bad.jpg", &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02]);
        assert!(verify_media_integrity(&jpg_ok, &jpg_ok).is_ok());
        assert!(verify_media_integrity(&jpg_bad, &jpg_bad).is_err());

        let gif_ok = write_temp("ok.gif", b"GIF89a\x01\x00\x01\x00\x3B");
        let gif_bad = write_temp("bad.gif", b"GIF89a\x01\x00\x01\x00");
        assert!(verify_media_integrity(&gif_ok, &gif_ok).is_ok());
        assert!(verify_media_integrity(&gif_bad, &gif_bad).is_err());

        let mut webp = Vec::new();
        webp.extend_from_slice(b"RIFF");
        webp.extend_from_slice(&12u32.to_le_bytes());
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(&[0u8; 8]);
        let webp_ok = write_temp("ok.webp", &webp);
        let webp_bad = write_temp("bad.webp", &webp[..16]);
        assert!(verify_media_integrity(&webp_ok, &webp_ok).is_ok());
        assert!(verify_media_integrity(&webp_bad, &webp_bad).is_err());

        let svg_ok = write_temp("ok.svg", b"<svg xmlns='http://www.w3.org/2000/svg'></svg>");
        let svg_bad = write_temp("bad.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><rect");
        assert!(verify_media_integrity(&svg_ok, &svg_ok).is_ok());
        assert!(verify_media_integrity(&svg_bad, &svg_bad).is_err());

        let mut mp4 = Vec::new();
        mp4.extend_from_slice(&16u32.to_be_bytes());
        mp4.extend_from_slice(b"ftyp");
        mp4.extend_from_slice(&[0u8; 8]);
        mp4.extend_from_slice(&20u32.to_be_bytes());
        mp4.extend_from_slice(b"mdat");
        mp4.extend_from_slice(&[0u8; 12]);
        let mp4_ok = write_temp("ok.mp4", &mp4);
        let mp4_bad = write_temp("bad.mp4", &mp4[..mp4.len() - 4]);
        assert!(verify_media_integrity(&mp4_ok, &mp4_ok).is_ok());
        assert!(verify_media_integrity(&mp4_bad, &mp4_bad).is_err());
    }

    #[test]
    fn parses_hex_and_base64_sha256_headers() {
        let hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(normalize_sha256_header(hex).as_deref(), Some(hex));
        // Base64 of SHA-256("")
        let b64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
        assert_eq!(normalize_sha256_header(b64).as_deref(), Some(hex));
        assert_eq!(normalize_sha256_header("not-a-sha"), None);
    }
}
