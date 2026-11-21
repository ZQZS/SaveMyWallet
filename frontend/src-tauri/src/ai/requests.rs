use std::{collections::HashMap, future::Future, sync::Mutex};
use tokio::task::AbortHandle;

#[derive(Default)]
pub(crate) struct AiRequests(Mutex<HashMap<String, AbortHandle>>);

impl AiRequests {
    pub(super) async fn run<T: Send + 'static>(
        &self,
        id: String,
        request: impl Future<Output = Result<T, String>> + Send + 'static,
    ) -> Result<T, String> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("AI_INVALID_INPUT".into());
        }
        let task = {
            let mut active = self.0.lock().map_err(|_| "AI_PROVIDER")?;
            if active.contains_key(&id) {
                return Err("AI_INVALID_INPUT".into());
            }
            let task = tokio::spawn(request);
            active.insert(id.clone(), task.abort_handle());
            task
        };
        let result = task.await;
        self.0.lock().map_err(|_| "AI_PROVIDER")?.remove(&id);
        match result {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => Err("AI_CANCELLED".into()),
            Err(_) => Err("AI_PROVIDER".into()),
        }
    }

    pub(super) fn cancel(&self, id: &str) -> Result<(), String> {
        if let Some(task) = self.0.lock().map_err(|_| "AI_PROVIDER")?.get(id) {
            task.abort();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn cancel_only_aborts_the_named_request_and_releases_its_id() {
        tauri::async_runtime::block_on(async {
            let requests = Arc::new(AiRequests::default());
            let (started, ready) = tokio::sync::oneshot::channel();
            let pending = requests.clone();
            let task = tokio::spawn(async move {
                pending
                    .run("first".into(), async {
                        started.send(()).unwrap();
                        std::future::pending::<Result<(), String>>().await
                    })
                    .await
            });
            ready.await.unwrap();
            requests.cancel("unrelated").unwrap();
            assert_eq!(
                requests
                    .run("first".into(), async { Ok(0) })
                    .await
                    .unwrap_err(),
                "AI_INVALID_INPUT"
            );
            requests.cancel("first").unwrap();
            assert_eq!(task.await.unwrap().unwrap_err(), "AI_CANCELLED");
            requests.cancel("first").unwrap();
            assert_eq!(
                requests.run("first".into(), async { Ok(3) }).await.unwrap(),
                3
            );
        });
    }
}
