//! Port of `src/server/lib/smtp.ts`: a minimal SMTP client.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

pub struct SmtpOptions {
    pub host: String,
    pub port: u16,
    pub secure: bool,
    pub ignore_tls: bool,
    pub username: Option<String>,
    pub password: Option<String>,
    pub timeout: Duration,
}

pub struct Envelope {
    pub from: String,
    pub to: String,
    /// Full RFC 5322 message with CRLF line endings.
    pub data: String,
}

struct Reply {
    code: u16,
    lines: Vec<String>,
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

struct Connection {
    stream: Box<dyn Stream>,
    buffer: Vec<u8>,
}

fn is_reply_end(line: &str) -> bool {
    let bytes = line.as_bytes();
    bytes.len() >= 3 && bytes[..3].iter().all(u8::is_ascii_digit) && (bytes.len() == 3 || bytes[3] == b' ')
}

impl Connection {
    async fn read(&mut self) -> Result<Reply, String> {
        let mut lines: Vec<String> = Vec::new();
        loop {
            while let Some(index) = self.buffer.iter().position(|b| *b == b'\n') {
                let raw: Vec<u8> = self.buffer.drain(..=index).collect();
                let mut line = String::from_utf8_lossy(&raw[..raw.len() - 1]).into_owned();
                if line.ends_with('\r') {
                    line.pop();
                }
                let done = is_reply_end(&line);
                lines.push(line);
                if done {
                    let code = lines.last().and_then(|l| l[..3].parse().ok()).unwrap_or(0);
                    // Each line is its code, a separator, then text.
                    let lines = lines.iter().map(|l| l.chars().skip(4).collect()).collect();
                    return Ok(Reply { code, lines });
                }
            }
            let mut chunk = [0u8; 4096];
            let read = self.stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if read == 0 {
                return Err("SMTP connection closed".into());
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }
    }

    async fn command(&mut self, line: Option<&str>, expected: &[u16], label: Option<&str>) -> Result<Reply, String> {
        if let Some(line) = line {
            self.stream.write_all(format!("{line}\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
        }
        let reply = self.read().await?;
        if !expected.contains(&reply.code) {
            let label = label.or_else(|| line.and_then(|l| l.split(' ').next())).unwrap_or("greeting");
            let text: String = reply.lines.join(" ").chars().take(200).collect();
            return Err(format!("SMTP {label} failed: {} {text}", reply.code));
        }
        Ok(reply)
    }
}

fn tls_connector() -> TlsConnector {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // Extra authorities, as Node and Bun take them (a private mail relay's CA).
    if let Ok(path) = std::env::var("NODE_EXTRA_CA_CERTS") {
        if let Ok(pem) = std::fs::read(&path) {
            for cert in rustls_pemfile::certs(&mut pem.as_slice()).flatten() {
                let _ = roots.add(cert);
            }
        }
    }
    let config = ClientConfig::builder_with_provider(Arc::new(tokio_rustls::rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("TLS protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

async fn secure(stream: Box<dyn Stream>, host: &str) -> Result<Box<dyn Stream>, String> {
    let name = ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
    let tls = tls_connector().connect(name, stream).await.map_err(|e| e.to_string())?;
    Ok(Box::new(tls))
}

fn capabilities(reply: &Reply) -> Vec<String> {
    reply.lines.iter().skip(1).map(|line| line.to_uppercase()).collect()
}

fn has_word(line: &str, word: &str) -> bool {
    line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).any(|w| w == word)
}

/// Leading dots are doubled so a line consisting of "." cannot end the DATA section early.
fn dot_stuff(data: &str) -> String {
    let mut out = String::with_capacity(data.len() + 16);
    for (i, line) in data.split("\r\n").enumerate() {
        if i > 0 {
            out.push_str("\r\n");
        }
        if line.starts_with('.') {
            out.push('.');
        }
        out.push_str(line);
    }
    out
}

/// `data.replace(/\r?\n/g, "\r\n")`.
fn crlf(data: &str) -> String {
    let mut out = String::with_capacity(data.len() + 16);
    let mut previous = '\0';
    for ch in data.chars() {
        if ch == '\n' && previous != '\r' {
            out.push('\r');
        }
        out.push(ch);
        previous = ch;
    }
    out
}

async fn deliver(options: &SmtpOptions, envelope: &Envelope) -> Result<(), String> {
    let tcp = TcpStream::connect((options.host.as_str(), options.port)).await.map_err(|e| e.to_string())?;
    let stream: Box<dyn Stream> = if options.secure { secure(Box::new(tcp), &options.host).await? } else { Box::new(tcp) };
    let mut connection = Connection { stream, buffer: Vec::new() };
    let name = hostname::get().ok().and_then(|h| h.into_string().ok()).filter(|h| !h.is_empty()).unwrap_or_else(|| "localhost".into());
    connection.command(None, &[220], None).await?;
    let mut ehlo = connection.command(Some(&format!("EHLO {name}")), &[250], None).await?;
    if !options.secure && !options.ignore_tls && capabilities(&ehlo).iter().any(|c| c == "STARTTLS") {
        connection.command(Some("STARTTLS"), &[220], None).await?;
        connection.stream = secure(std::mem::replace(&mut connection.stream, Box::new(tokio::io::empty())), &options.host).await?;
        connection.buffer.clear();
        ehlo = connection.command(Some(&format!("EHLO {name}")), &[250], None).await?;
    }
    if let Some(username) = &options.username {
        let auth = capabilities(&ehlo).into_iter().find(|line| line.starts_with("AUTH")).unwrap_or_default();
        let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
        let password = options.password.clone().unwrap_or_default();
        if has_word(&auth, "PLAIN") || !has_word(&auth, "LOGIN") {
            connection.command(Some(&format!("AUTH PLAIN {}", b64(&format!("\0{username}\0{password}")))), &[235], Some("AUTH")).await?;
        } else {
            connection.command(Some("AUTH LOGIN"), &[334], Some("AUTH")).await?;
            connection.command(Some(&b64(username)), &[334], Some("AUTH")).await?;
            connection.command(Some(&b64(&password)), &[235], Some("AUTH")).await?;
        }
    }
    connection.command(Some(&format!("MAIL FROM:<{}>", envelope.from)), &[250], None).await?;
    connection.command(Some(&format!("RCPT TO:<{}>", envelope.to)), &[250, 251], None).await?;
    connection.command(Some("DATA"), &[354], None).await?;
    let data = format!("{}\r\n.\r\n", dot_stuff(&crlf(&envelope.data)));
    connection.stream.write_all(data.as_bytes()).await.map_err(|e| e.to_string())?;
    connection.command(None, &[250], Some("DATA")).await?;
    // The message is accepted; a failed goodbye changes nothing.
    let _ = connection.command(Some("QUIT"), &[221], None).await;
    Ok(())
}

pub async fn send_smtp(options: &SmtpOptions, envelope: &Envelope) -> Result<(), String> {
    match tokio::time::timeout(options.timeout, deliver(options, envelope)).await {
        Ok(result) => result,
        Err(_) => Err("SMTP timeout".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stuffs_dots_and_normalises_line_ends() {
        assert_eq!(dot_stuff(".a\r\n..b\r\nc.\r\n."), "..a\r\n...b\r\nc.\r\n..");
        assert_eq!(crlf("a\nb\r\nc"), "a\r\nb\r\nc");
        assert!(is_reply_end("250 ok") && is_reply_end("250") && !is_reply_end("250-more") && !is_reply_end("25"));
        assert!(has_word("AUTH PLAIN LOGIN", "LOGIN") && !has_word("AUTH XLOGIN", "LOGIN"));
    }
}
