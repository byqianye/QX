use std::io;
use std::sync::atomic::{AtomicU32, Ordering};

use tokio::net::TcpListener;

const FIRST_FIXTURE_PORT: u32 = 20_000;
const FIXTURE_PORT_COUNT: u32 = 10_000;
static NEXT_FIXTURE_PORT: AtomicU32 = AtomicU32::new(FIRST_FIXTURE_PORT);

pub(crate) async fn bind_loopback_tcp() -> io::Result<TcpListener> {
    let mut last_error = None;
    for _ in 0..FIXTURE_PORT_COUNT {
        let sequence = NEXT_FIXTURE_PORT.fetch_add(1, Ordering::Relaxed);
        let port = FIRST_FIXTURE_PORT + (sequence - FIRST_FIXTURE_PORT) % FIXTURE_PORT_COUNT;
        match TcpListener::bind(("127.0.0.1", port as u16)).await {
            Ok(listener) => return Ok(listener),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(io::ErrorKind::AddrNotAvailable, "no loopback fixture port")
    }))
}

pub(crate) fn bind_loopback_tcp_std() -> io::Result<std::net::TcpListener> {
    let mut last_error = None;
    for _ in 0..FIXTURE_PORT_COUNT {
        let sequence = NEXT_FIXTURE_PORT.fetch_add(1, Ordering::Relaxed);
        let port = FIRST_FIXTURE_PORT + (sequence - FIRST_FIXTURE_PORT) % FIXTURE_PORT_COUNT;
        match std::net::TcpListener::bind(("127.0.0.1", port as u16)) {
            Ok(listener) => return Ok(listener),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(io::ErrorKind::AddrNotAvailable, "no loopback fixture port")
    }))
}
