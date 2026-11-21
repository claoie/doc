//! Port of `src/server/lib/zip.ts`: a streamed zip writer (deflate for
//! in-memory entries, stored for streamed ones).

use std::io::{self, Write};
use std::sync::OnceLock;

use bytes::Bytes;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use futures_util::StreamExt;
use tokio::sync::mpsc;

use crate::common::jsdate::{local_zone, utc_fields};
use crate::storage::StoredObject;

const LIMIT: u64 = 0xffff_ffff;

fn crc_table() -> &'static [u32; 256] {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (n, slot) in table.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 == 1 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        table
    })
}

pub fn crc32_update(crc: u32, bytes: &[u8]) -> u32 {
    let table = crc_table();
    let mut c = crc ^ 0xffff_ffff;
    for byte in bytes {
        c = table[((c ^ u32::from(*byte)) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

pub fn crc32(bytes: &[u8]) -> u32 {
    crc32_update(0, bytes)
}

/// The DOS time and date of now, in the process's local zone.
fn dos_date_time() -> (u16, u16) {
    let now = chrono::Utc::now().timestamp_millis();
    let local = now + local_zone().offset_at(now);
    let Some(fields) = utc_fields(local as f64) else { return (0, 0) };
    let year = fields.year.max(1980);
    let time = (fields.hours << 11) | (fields.minutes << 5) | (fields.seconds / 2);
    let date = ((year - 1980) << 9) | ((fields.month + 1) << 5) | fields.date;
    (time as u16, date as u16)
}

struct Record {
    name: Vec<u8>,
    method: u16,
    crc: u32,
    compressed_size: u32,
    size: u32,
    offset: u32,
    time: u16,
    date: u16,
}

fn local_header(r: &Record) -> Vec<u8> {
    let mut out = Vec::with_capacity(30 + r.name.len());
    out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes());
    out.extend_from_slice(&0x0800u16.to_le_bytes());
    out.extend_from_slice(&r.method.to_le_bytes());
    out.extend_from_slice(&r.time.to_le_bytes());
    out.extend_from_slice(&r.date.to_le_bytes());
    out.extend_from_slice(&r.crc.to_le_bytes());
    out.extend_from_slice(&r.compressed_size.to_le_bytes());
    out.extend_from_slice(&r.size.to_le_bytes());
    out.extend_from_slice(&(r.name.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&r.name);
    out
}

fn central_header(r: &Record) -> Vec<u8> {
    let mut out = Vec::with_capacity(46 + r.name.len());
    out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes());
    out.extend_from_slice(&0x0800u16.to_le_bytes());
    out.extend_from_slice(&r.method.to_le_bytes());
    out.extend_from_slice(&r.time.to_le_bytes());
    out.extend_from_slice(&r.date.to_le_bytes());
    out.extend_from_slice(&r.crc.to_le_bytes());
    out.extend_from_slice(&r.compressed_size.to_le_bytes());
    out.extend_from_slice(&r.size.to_le_bytes());
    out.extend_from_slice(&(r.name.len() as u16).to_le_bytes());
    // Extra length, comment length, disk number, internal and external attributes.
    out.extend_from_slice(&[0u8; 12]);
    out.extend_from_slice(&r.offset.to_le_bytes());
    out.extend_from_slice(&r.name);
    out
}

fn end_of_central_directory(count: usize, size: u64, offset: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(22);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    out.extend_from_slice(&(count as u16).to_le_bytes());
    out.extend_from_slice(&(count as u16).to_le_bytes());
    out.extend_from_slice(&(size as u32).to_le_bytes());
    out.extend_from_slice(&(offset as u32).to_le_bytes());
    out.extend_from_slice(&[0u8; 2]);
    out
}

/// `Bun.deflateSync(raw)`: a raw deflate stream at the default level.
fn deflate(raw: &[u8]) -> io::Result<Vec<u8>> {
    let mut encoder = DeflateEncoder::new(Vec::with_capacity(raw.len() / 2 + 16), Compression::default());
    encoder.write_all(raw)?;
    encoder.finish()
}

pub type ZipSender = mpsc::Sender<io::Result<Bytes>>;

/// Writes an archive into a channel as its entries are added.
pub struct ZipWriter {
    tx: ZipSender,
    records: Vec<Record>,
    offset: u64,
}

impl ZipWriter {
    pub fn new(tx: ZipSender) -> ZipWriter {
        ZipWriter { tx, records: Vec::new(), offset: 0 }
    }

    async fn send(&self, bytes: Vec<u8>) -> io::Result<()> {
        self.tx.send(Ok(Bytes::from(bytes))).await.map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the reader of the archive went away"))
    }

    fn check_count(&self) -> io::Result<()> {
        if self.records.len() >= 0xffff {
            return Err(io::Error::other("too many zip entries"));
        }
        Ok(())
    }

    /// An entry held in memory, deflated when that makes it smaller.
    pub async fn add_data(&mut self, name: &str, raw: &[u8]) -> io::Result<()> {
        self.check_count()?;
        let (time, date) = dos_date_time();
        let name = crate::jsutil::to_text(name).as_bytes().to_vec();
        let compressed = deflate(raw)?;
        let deflated = compressed.len() < raw.len();
        let body = if deflated { compressed } else { raw.to_vec() };
        let record = Record {
            name,
            method: if deflated { 8 } else { 0 },
            crc: crc32(raw),
            compressed_size: body.len() as u32,
            size: raw.len() as u32,
            offset: self.offset as u32,
            time,
            date,
        };
        if self.offset + 30 + record.name.len() as u64 + body.len() as u64 > LIMIT {
            return Err(io::Error::other("zip archive too large"));
        }
        let header = local_header(&record);
        self.offset += (header.len() + body.len()) as u64;
        self.send(header).await?;
        self.send(body).await?;
        self.records.push(record);
        Ok(())
    }

    /// A stored object, streamed without compression; it is read twice (checksum pass, then data pass).
    pub async fn add_object(&mut self, name: &str, object: &StoredObject) -> io::Result<()> {
        self.check_count()?;
        let (time, date) = dos_date_time();
        let entry = crate::jsutil::to_text(name).as_bytes().to_vec();
        if self.offset + object.size + 30 + entry.len() as u64 > LIMIT {
            return Err(io::Error::other("zip archive too large"));
        }
        let mut crc = 0u32;
        let mut size = 0u64;
        let mut chunks = object.stream(None).await?;
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            crc = crc32_update(crc, &chunk);
            size += chunk.len() as u64;
        }
        let record = Record { name: entry, method: 0, crc, compressed_size: size as u32, size: size as u32, offset: self.offset as u32, time, date };
        let header = local_header(&record);
        let header_length = header.len() as u64;
        self.send(header).await?;
        let mut written = 0u64;
        let mut chunks = object.stream(None).await?;
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            written += chunk.len() as u64;
            self.tx.send(Ok(chunk)).await.map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the reader of the archive went away"))?;
        }
        if written != size {
            return Err(io::Error::other(format!("zip entry {name} changed while archiving")));
        }
        self.offset += header_length + size;
        self.records.push(record);
        Ok(())
    }

    /// Writes the central directory.
    pub async fn finish(self) -> io::Result<()> {
        let directory_offset = self.offset;
        let mut directory_size = 0u64;
        for record in &self.records {
            let header = central_header(record);
            directory_size += header.len() as u64;
            self.send(header).await?;
        }
        self.send(end_of_central_directory(self.records.len(), directory_size, directory_offset)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksums() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32_update(crc32(b"1234"), b"56789"), 0xcbf4_3926);
    }

    #[tokio::test]
    async fn writes_an_archive() {
        let (tx, mut rx) = mpsc::channel(64);
        let mut zip = ZipWriter::new(tx);
        zip.add_data("a.txt", b"hi").await.unwrap();
        zip.add_data("dir/b.txt", "repeat ".repeat(50).as_bytes()).await.unwrap();
        zip.finish().await.unwrap();
        let mut bytes = Vec::new();
        while let Some(chunk) = rx.recv().await {
            bytes.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(&bytes[..4], &[0x50, 0x4b, 0x03, 0x04]);
        let end = bytes.len() - 22;
        assert_eq!(&bytes[end..end + 4], &[0x50, 0x4b, 0x05, 0x06]);
        assert_eq!(u16::from_le_bytes([bytes[end + 10], bytes[end + 11]]), 2);
        // The short entry is stored, the repetitive one deflated.
        assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), 0);
        let second = 30 + 5 + 2;
        assert_eq!(u16::from_le_bytes([bytes[second + 8], bytes[second + 9]]), 8);
    }
}
