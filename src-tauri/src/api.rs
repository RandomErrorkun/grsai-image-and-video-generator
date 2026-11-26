//! HTTP calls for the Grsai API, made from Rust so connections are pooled and
//! so the caller can tell "never sent" apart from "sent, outcome unknown".

use std::{
    collections::HashMap,
    path::Path,
    str::FromStr,
    sync::Mutex,
    time::Duration,
};

use reqwest::{Client, Method, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::AsyncWriteExt;

/// What became of one HTTP call. Network trouble is reported here instead of
/// as a bare error string, so the caller never has to parse messages.
#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum HttpOutcome {    /// The server answered. `body` is the response text, empty for downloads.
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
    /// Where to store the file. It is written only once the body is complete.
    dest_path: String,
}

#[derive(Default)]
pub struct ApiState {
    /// One client per timeout pair; each keeps its own connection pool alive between calls.
    clients: Mutex<HashMap<(u64, u64), Client>>,
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

async fn download_outcome(
    state: &ApiState,
    spec: DownloadSpec,
) -> Result<HttpOutcome, HttpOutcome> {
    let client = state.client(spec.connect_timeout_secs, spec.read_timeout_secs)?;
    let request = build(client, "GET", &spec.url, &spec.headers, None)?;
    let mut response = send(request).await?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        return Ok(HttpOutcome::Responded { status, body });
    }
    let dest = Path::new(&spec.dest_path);
    match write_body(&mut response, dest).await {
        Ok(()) => Ok(HttpOutcome::Responded {
            status,
            body: String::new(),
        }),
        Err(message) => {
            // Never leave a half-written result behind.
            let _ = tokio::fs::remove_file(dest).await;
            Err(HttpOutcome::Unknown {
                message,
                status: Some(status),
            })
        }
    }
}

async fn write_body(response: &mut Response, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let file = tokio::fs::File::create(dest)
        .await
        .map_err(|error| error.to_string())?;
    let mut writer = tokio::io::BufWriter::with_capacity(512 * 1024, file);
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        writer.write_all(&chunk).await.map_err(|error| error.to_string())?;
    }
    writer.flush().await.map_err(|error| error.to_string())
}
