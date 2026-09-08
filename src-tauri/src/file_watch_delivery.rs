use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

pub(super) enum Delivery<T> {
    Event(T),
    Flush,
}

/// Keeps batching and notification delivery inside the file watch worker.
pub(super) fn run<T>(
    events: Receiver<T>,
    stop: Receiver<()>,
    delay: Duration,
    mut deliver: impl FnMut(Delivery<T>),
) {
    let mut deadline = Instant::now() + delay;
    loop {
        if stop.try_recv().is_ok() {
            return;
        }
        let received = events.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        if stop.try_recv().is_ok() {
            return;
        }
        match received {
            Ok(event) => deliver(Delivery::Event(event)),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                deliver(Delivery::Flush);
                return;
            }
        }
        // Traffic cannot extend the batch indefinitely. This also bounds the
        // delay when unrelated events keep the watched directory busy.
        if Instant::now() >= deadline {
            deliver(Delivery::Flush);
            deadline = Instant::now() + delay;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Instant;

    #[test]
    fn flushes_while_events_keep_arriving() {
        let (events_tx, events_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let (flushed_tx, flushed_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let mut pending = false;
            run(
                events_rx,
                stop_rx,
                Duration::from_millis(30),
                |action| match action {
                    Delivery::Event(()) => pending = true,
                    Delivery::Flush if pending => {
                        let _ = flushed_tx.send(());
                        pending = false;
                    }
                    _ => {}
                },
            );
        });
        let started = Instant::now();
        let mut flushed = false;
        while started.elapsed() < Duration::from_millis(500) {
            events_tx.send(()).unwrap();
            if flushed_rx.try_recv().is_ok() {
                flushed = true;
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        stop_tx.send(()).unwrap();
        drop(events_tx);
        worker.join().unwrap();
        assert!(
            flushed,
            "continuous file events must not indefinitely postpone refresh"
        );
    }

    #[test]
    fn flushes_the_last_batch_on_disconnect() {
        let (tx, rx) = mpsc::channel();
        let (_stop_tx, stop_rx) = mpsc::channel();
        tx.send(7).unwrap();
        drop(tx);
        let mut result = Vec::new();
        run(rx, stop_rx, Duration::from_secs(1), |action| match action {
            Delivery::Event(value) => result.push(value),
            Delivery::Flush => result.push(0),
        });
        assert_eq!(result, vec![7, 0]);
    }

    #[test]
    fn stop_discards_undelivered_events() {
        let (tx, rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        tx.send(7).unwrap();
        stop_tx.send(()).unwrap();
        run(rx, stop_rx, Duration::from_millis(1), |_| {
            panic!("watch was stopped")
        });
    }
}
